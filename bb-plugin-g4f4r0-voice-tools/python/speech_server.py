"""Local speech-to-text server used by the Voice tools bb plugin.

The plugin's host entry installs this file into its data directory and runs it
with the plugin-managed Python environment. It also runs on its own:

    python speech_server.py --port 8765 --model parakeet-v3

Endpoints:
  GET    /health                        {"ready": true, "model": ...}
  POST   /v1/audio/transcriptions       OpenAI-compatible multipart upload -> {"text"}
  POST   /v1/stream                     start a live dictation -> {"id"}
  POST   /v1/stream/{id}/audio          raw 16 kHz mono int16 PCM -> {"text", "seconds"}
  POST   /v1/stream/{id}/finish         transcribe the rest -> {"text", "seconds"}
  DELETE /v1/stream/{id}                discard

Live dictation transcribes while the speaker talks: audio is cut at pauses
and each piece is recognized in the background, so finishing only has to
handle the last few seconds, however long the dictation was.

Uploaded files are decoded with PyAV (bundled FFmpeg), so no system ffmpeg is
needed. Models: NVIDIA Parakeet TDT 0.6B v3 (onnx-asr, CPU) or Whisper
(faster-whisper/CTranslate2, CPU or CUDA).
"""

import argparse
import io
import logging
import os
import queue
import sys
import threading
import time
import uuid

MAX_UPLOAD_BYTES = 25 * 1024 * 1024
SAMPLE_RATE = 16000
MAX_STREAM_S = 20 * 60
STREAM_IDLE_S = 120

log = logging.getLogger("speech-server")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--model", default="parakeet-v3")
    parser.add_argument("--language", default="auto", help="Whisper only: ISO code such as en, or auto")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"], help="Whisper only")
    parser.add_argument("--threads", type=int, default=0, help="0 = automatic")
    parser.add_argument("--models-dir", default=None, help="Model download cache")
    parser.add_argument(
        "--idle-unload-minutes",
        type=float,
        default=10,
        help="Free the model's memory after this long without use; 0 keeps it loaded",
    )
    parser.add_argument(
        "--watch-stdin",
        action="store_true",
        help="Exit when stdin closes (the bb plugin holds it open while it runs)",
    )
    return parser.parse_args()


def watch_stdin() -> None:
    """Exit when the bb host worker that started us goes away (any OS)."""

    def loop() -> None:
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:
            pass
        log.warning("parent closed stdin; exiting")
        os._exit(0)

    threading.Thread(target=loop, name="parent-watch", daemon=True).start()


# ── audio ──────────────────────────────────────────────────────────────────


def decode_audio(data: bytes):
    """Decode any container PyAV knows (webm, mp4, ogg, wav, mp3) to 16 kHz mono float32.

    Written against the PyAV API shared by versions 12-19; faster-whisper's own
    decoder passes an argument PyAV 19 removed.
    """
    import av
    import numpy as np

    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    # BytesIO is seekable, so MP4 with its index at the end decodes too.
    with av.open(io.BytesIO(data), mode="r") as container:
        stream = next(s for s in container.streams if s.type == "audio")
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32) / 32768.0


def container_duration(data: bytes) -> str:
    """Duration the container claims, to compare with what decodes (diagnostics)."""
    try:
        import av

        with av.open(io.BytesIO(data), mode="r") as container:
            if container.duration:
                return f"{container.duration / 1_000_000:.1f}s"
    except Exception:
        pass
    return "unknown"


def keep_last_upload(models_dir, data: bytes, content_type: str) -> None:
    """Keep only the most recent upload next to the models, for diagnosing
    lost audio; each upload overwrites the previous one."""
    if not models_dir:
        return
    try:
        path = os.path.join(os.path.dirname(os.path.abspath(models_dir)), "last-upload.bin")
        with open(path, "wb") as handle:
            handle.write(data)
        with open(path + ".type", "w") as handle:
            handle.write(content_type)
    except OSError:
        pass


def frame_energy(audio):
    """Mean power per 10 ms frame, smoothed over ~200 ms."""
    import numpy as np

    hop = SAMPLE_RATE // 100
    usable = audio.size - audio.size % hop
    if usable == 0:
        return np.zeros(0, dtype=np.float32)
    energy = (audio[:usable].reshape(-1, hop) ** 2).mean(axis=1)
    return np.convolve(energy, np.ones(21) / 21, mode="same")


def split_at_pauses(audio, max_s: float, min_s: float) -> list:
    """Cut audio into <= max_s pieces at the quietest point after min_s."""
    import numpy as np

    max_len = int(max_s * SAMPLE_RATE)
    if audio.size <= max_len:
        return [audio]
    energy = frame_energy(audio)
    hop = SAMPLE_RATE // 100
    pieces, start = [], 0
    while audio.size - start > max_len:
        lo = (start + int(min_s * SAMPLE_RATE)) // hop
        hi = (start + max_len) // hop
        cut = (lo + int(np.argmin(energy[lo:hi]))) * hop
        pieces.append(audio[start:cut])
        start = cut
    pieces.append(audio[start:])
    return pieces


def quiet_runs(quiet):
    """(start, end) frame ranges where `quiet` is True."""
    import numpy as np

    padded = np.concatenate([[False], quiet, [False]])
    edges = np.flatnonzero(np.diff(padded.astype(np.int8)))
    return list(zip(edges[0::2], edges[1::2]))


# ── engines ────────────────────────────────────────────────────────────────


class WhisperEngine:
    """OpenAI Whisper through faster-whisper (CTranslate2); every language."""

    def __init__(self, args: argparse.Namespace):
        from faster_whisper import WhisperModel

        name = args.model.removeprefix("whisper-")
        self.threads = args.threads if args.threads > 0 else max(1, min(8, (os.cpu_count() or 2) // 2))
        device = args.device
        if device == "auto":
            try:
                import ctranslate2

                device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
            except Exception:
                device = "cpu"
        self.device = device
        compute_type = "int8_float16" if device == "cuda" else "int8"
        log.info("loading whisper %s on %s (%s, %d threads)", name, device, compute_type, self.threads)
        self.model = WhisperModel(
            name,
            device=device,
            compute_type=compute_type,
            cpu_threads=self.threads,
            download_root=args.models_dir,
        )

    @staticmethod
    def repo(model: str) -> str:
        from faster_whisper.utils import _MODELS

        return _MODELS.get(model.removeprefix("whisper-"), "")

    def transcribe(self, audio, language, prompt) -> str:
        segments, _ = self.model.transcribe(
            audio,
            language=language,
            initial_prompt=prompt,
            beam_size=5,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments if s.text.strip())


class ParakeetEngine:
    """NVIDIA Parakeet TDT 0.6B v3 (int8 ONNX) through onnx-asr, on the CPU.

    Detects among 25 European languages by itself; takes no language or prompt.
    """

    # Long recordings are cut at pauses into ~6-12 s pieces and decoded as
    # one batch: ~33% faster than one long piece (34 s: 2.6 s vs 3.9 s), and
    # time and memory stay linear for long uploads.
    MAX_PIECE_S = 12.0
    MIN_PIECE_S = 6.0
    MAX_BATCH = 8
    REPO = "istupakov/parakeet-tdt-0.6b-v3-onnx"

    def __init__(self, args: argparse.Namespace):
        if args.models_dir:
            os.environ["HF_HUB_CACHE"] = args.models_dir
        import onnx_asr
        import onnxruntime as rt

        options = rt.SessionOptions()
        # Idle threads sleep instead of spinning: on a busy machine spinning
        # made inference ~1.5x slower and burned CPU between dictations.
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        # No arena / memory-pattern caches: ~240 MB less resident memory with
        # no measurable speed cost for this model.
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        # Every core: a finished recording is transcribed as one batch, and
        # with spinning off idle threads cost nothing. 16 threads were ~25%
        # faster than 8 on a 16-vCPU machine.
        self.threads = args.threads if args.threads > 0 else max(1, os.cpu_count() or 1)
        options.intra_op_num_threads = self.threads
        options.inter_op_num_threads = 1
        self.device = "cpu"
        log.info("loading parakeet-tdt-0.6b-v3 (int8) on cpu")
        self.model = onnx_asr.load_model(
            "nemo-parakeet-tdt-0.6b-v3", quantization="int8", sess_options=options
        )

    def transcribe(self, audio, language, prompt) -> str:
        import numpy as np

        # Silence around each piece: the decoder drops a first word that starts
        # at sample 0 (a cut mid-dictation) and a last word cut off by the stop
        # button ("Ask" -> "Ask not" in testing).
        lead = np.zeros(int(0.3 * SAMPLE_RATE), dtype=np.float32)
        tail = np.zeros(int(0.6 * SAMPLE_RATE), dtype=np.float32)
        pieces = [np.concatenate([lead, p, tail]) for p in split_at_pauses(audio, self.MAX_PIECE_S, self.MIN_PIECE_S)]
        texts = []
        for i in range(0, len(pieces), self.MAX_BATCH):
            texts.extend(self.model.recognize(pieces[i : i + self.MAX_BATCH], sample_rate=SAMPLE_RATE))
        return " ".join(t.strip() for t in texts if t and t.strip())


def load_engine(args: argparse.Namespace):
    import numpy as np

    started = time.monotonic()
    if args.model == "parakeet-v3":
        engine = ParakeetEngine(args)
    elif args.model.startswith("whisper-"):
        engine = WhisperEngine(args)
    else:
        raise SystemExit(f"unknown model {args.model!r}")
    log.info("model loaded in %.1fs", time.monotonic() - started)
    # The first inference allocates and tunes kernels; pay that now, not on
    # the first piece of speech.
    started = time.monotonic()
    rng = np.random.default_rng(0)
    engine.transcribe((rng.standard_normal(2 * SAMPLE_RATE) * 0.01).astype(np.float32), None, None)
    log.info("warmed up in %.1fs", time.monotonic() - started)
    return engine


def prune_models(models_dir, keep_repo: str) -> None:
    """Delete downloaded models other than `keep_repo` (Hugging Face cache layout).

    huggingface_hub 2.x shares blob files at the cache root, so a blob is only
    removed when no kept model links to it.
    """
    import shutil

    if not models_dir or not keep_repo or not os.path.isdir(models_dir):
        return
    keep_dir = "models--" + keep_repo.replace("/", "--")
    for name in os.listdir(models_dir):
        if name.startswith("models--") and name != keep_dir:
            shutil.rmtree(os.path.join(models_dir, name), ignore_errors=True)
            log.info("removed unused model %s", name)
    keep = set()
    for root, _dirs, files in os.walk(os.path.join(models_dir, keep_dir)):
        for name in files:
            keep.add(os.path.realpath(os.path.join(root, name)))
    shared = os.path.join(models_dir, "blobs")
    for root, _dirs, files in os.walk(shared):
        for name in files:
            path = os.path.realpath(os.path.join(root, name))
            if path not in keep:
                os.remove(path)


def release_memory() -> None:
    """Hand freed heap pages back to the OS (glibc keeps them otherwise)."""
    import gc

    gc.collect()
    try:
        import ctypes

        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


class Model:
    """The loaded engine, loaded on demand and freed after idle_s without use.

    `lock` serializes inference and loading; hold it around `get()` and the
    call that uses the engine.
    """

    def __init__(self, args: argparse.Namespace, busy):
        self.args = args
        self.busy = busy  # callable: True while a dictation is open
        self.lock = threading.Lock()
        self.engine = None
        self.last_used = time.monotonic()
        self.idle_s = max(0.0, args.idle_unload_minutes * 60)

    def get(self):
        self.last_used = time.monotonic()
        if self.engine is None:
            self.engine = load_engine(self.args)
            self.last_used = time.monotonic()
        return self.engine

    def preload(self) -> None:
        """Start loading in the background (a dictation just began)."""
        if self.engine is not None:
            return

        def run() -> None:
            with self.lock:
                self.get()

        threading.Thread(target=run, name="preload", daemon=True).start()

    def watch_idle(self) -> None:
        if self.idle_s <= 0:
            return

        def loop() -> None:
            while True:
                time.sleep(15)
                if self.engine is None or self.busy() or time.monotonic() - self.last_used < self.idle_s:
                    continue
                with self.lock:
                    if self.engine is None or time.monotonic() - self.last_used < self.idle_s:
                        continue
                    self.engine = None
                    release_memory()
                    log.info("model unloaded after %.0f idle minutes", self.idle_s / 60)

        threading.Thread(target=loop, name="idle-unload", daemon=True).start()


# ── live dictation ─────────────────────────────────────────────────────────


class StreamSession:
    """One live dictation: buffers PCM, cuts it at pauses, transcribes in the background.

    Cut rules, checked after every chunk:
    - the speaker went quiet (>= 0.6 s of silence at the end after >= 0.8 s of
      speech): transcribe now. People pause before pressing stop, so the
      tail left for `finish` is usually silence and finishing is instant;
    - the piece passed MIN_PIECE_S and has a pause (>= 0.2 s): cut there;
      longer pieces keep punctuation and cost fewer model calls;
    - the piece reached MAX_PIECE_S without a pause: cut at its quietest point.
    Pieces without speech are dropped.
    """

    MIN_PIECE_S = 6.0
    MAX_PIECE_S = 20.0
    HOP = SAMPLE_RATE // 100  # 10 ms energy frames

    def __init__(self, model: "Model", language):
        import numpy as np

        self.model = model
        self.language = language
        self.pending = np.zeros(0, dtype=np.float32)
        self.total_samples = 0
        # Loudest speech so far (80th-percentile frame energy); silence is
        # judged relative to it so it adapts to the microphone's gain.
        self.speech_level = 1e-5
        self.texts: list = []
        self.error = None
        self.touched = time.monotonic()
        self.jobs: "queue.Queue" = queue.Queue()
        self.worker = threading.Thread(target=self._work, name="stream-worker", daemon=True)
        self.worker.start()

    def append(self, pcm: bytes) -> None:
        import numpy as np

        self.touched = time.monotonic()
        usable = len(pcm) - len(pcm) % 2
        samples = np.frombuffer(pcm[:usable], dtype="<i2").astype(np.float32) / 32768.0
        self.total_samples += samples.size
        chunk_energy = frame_energy(samples)
        if chunk_energy.size:
            self.speech_level = max(self.speech_level, float(np.percentile(chunk_energy, 80)))
        self.pending = np.concatenate([self.pending, samples])
        while True:
            cut = self._find_cut()
            if cut is None:
                break
            self._submit(self.pending[:cut])
            self.pending = self.pending[cut:]

    def _quiet(self, energy):
        return energy < 0.05 * self.speech_level

    def _find_cut(self):
        import numpy as np

        energy = frame_energy(self.pending)
        if energy.size < 50:
            return None
        quiet = self._quiet(energy)
        runs = quiet_runs(quiet)
        speech_frames = int((~quiet).sum())
        # 1. Trailing silence after real speech: the speaker paused.
        # Keep 250 ms after the speech so soft word endings ("-s") survive.
        if runs and runs[-1][1] == energy.size and runs[-1][1] - runs[-1][0] >= 60 and speech_frames >= 80:
            return (runs[-1][0] + 25) * self.HOP
        # 2. A pause after the minimum length.
        min_frame = int(self.MIN_PIECE_S * 100)
        pauses = [(a, b) for a, b in runs if b - a >= 20 and (a + b) // 2 >= min_frame and b < energy.size]
        if pauses:
            a, b = pauses[-1]
            return ((a + b) // 2) * self.HOP
        # 3. Too long without a pause: quietest point in the back half.
        if self.pending.size >= self.MAX_PIECE_S * SAMPLE_RATE:
            lo = int(self.MAX_PIECE_S * 50)
            return (lo + int(np.argmin(energy[lo:]))) * self.HOP
        return None

    def _submit(self, piece) -> None:
        energy = frame_energy(piece)
        if energy.size == 0 or not (~self._quiet(energy)).any():
            return  # no speech: skip the model call
        self.jobs.put(piece)

    def finish(self) -> str:
        if self.pending.size:
            self._submit(self.pending)
            self.pending = self.pending[:0]
        self.jobs.put(None)
        self.worker.join()
        if self.error is not None:
            raise self.error
        return self.text()

    def cancel(self) -> None:
        self.jobs.put(None)

    def text(self) -> str:
        return " ".join(self.texts)

    @property
    def seconds(self) -> float:
        return self.total_samples / SAMPLE_RATE

    def _work(self) -> None:
        while True:
            piece = self.jobs.get()
            if piece is None:
                return
            if self.error is not None or piece.size < SAMPLE_RATE // 10:
                continue
            try:
                started = time.monotonic()
                with self.model.lock:
                    text = self.model.get().transcribe(piece, self.language, None).strip()
                log.info(
                    "stream piece %.1fs in %.2fs (%d chars)",
                    piece.size / SAMPLE_RATE, time.monotonic() - started, len(text),
                )
                if text:
                    self.texts.append(text)
            except Exception as error:  # surfaced on finish
                log.exception("stream piece failed")
                self.error = error


# ── app ────────────────────────────────────────────────────────────────────


def build_app(args: argparse.Namespace):
    from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
    from fastapi.responses import PlainTextResponse

    default_language = None if args.language in ("", "auto") else args.language
    sessions: dict = {}
    sessions_lock = threading.Lock()
    model = Model(args, busy=lambda: bool(sessions))
    # Load (and download on first run) before reporting healthy, then drop
    # every other model's files; the idle watcher frees memory later.
    with model.lock:
        loaded = model.get()
        device, threads = loaded.device, loaded.threads
        del loaded  # hold no reference, or idle unload could not free it
    prune_models(args.models_dir, ParakeetEngine.REPO if args.model == "parakeet-v3" else WhisperEngine.repo(args.model))
    model.watch_idle()
    app = FastAPI(title="Voice tools", docs_url=None, redoc_url=None)

    def session(stream_id: str) -> StreamSession:
        with sessions_lock:
            found = sessions.get(stream_id)
        if found is None:
            raise HTTPException(404, "This dictation has expired. Start a new one.")
        return found

    def expire_idle() -> None:
        now = time.monotonic()
        with sessions_lock:
            stale = [k for k, s in sessions.items() if now - s.touched > STREAM_IDLE_S]
            for key in stale:
                sessions.pop(key).cancel()
        for key in stale:
            log.info("expired idle stream %s", key)

    @app.get("/health")
    def health() -> dict:
        return {
            "ready": True,
            "model": args.model,
            "device": device,
            "threads": threads,
            "loaded": model.engine is not None,
            "language": default_language or "auto",
            "streams": len(sessions),
        }

    @app.post("/v1/audio/transcriptions")
    def transcriptions(
        file: UploadFile = File(...),
        response_format: str = Form("json"),
        language: str = Form(""),
        prompt: str = Form(""),
    ):
        data = file.file.read(MAX_UPLOAD_BYTES + 1)
        if len(data) > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "Audio exceeds 25 MB")
        if not data:
            raise HTTPException(400, "The recording is empty. Record it again.")
        started = time.monotonic()
        try:
            audio = decode_audio(data)
            keep_last_upload(args.models_dir, data, file.content_type or "")
        except Exception as error:
            log.warning("audio decode failed: bytes=%d error=%s", len(data), type(error).__name__)
            raise HTTPException(400, "Could not decode the recording. Record it again.") from None
        text = ""
        if audio.size >= SAMPLE_RATE // 10:
            with model.lock:
                text = model.get().transcribe(audio, language.strip() or default_language, prompt.strip() or None)
        log.info(
            "transcribed %.1fs of audio (%s, %d bytes, container says %s) in %.2fs (%d chars): ...%s",
            audio.size / SAMPLE_RATE, file.content_type, len(data), container_duration(data),
            time.monotonic() - started, len(text), text[-60:],
        )
        if response_format == "text":
            return PlainTextResponse(text)
        return {"text": text}

    @app.post("/v1/stream")
    def stream_start() -> dict:
        expire_idle()
        stream_id = uuid.uuid4().hex
        with sessions_lock:
            sessions[stream_id] = StreamSession(model, default_language)
        # If the model was freed while idle, load it while the user talks.
        model.preload()
        log.info("stream %s started", stream_id)
        return {"id": stream_id}

    @app.post("/v1/stream/{stream_id}/audio")
    async def stream_audio(stream_id: str, request: Request) -> dict:
        found = session(stream_id)
        pcm = await request.body()
        if found.seconds + len(pcm) / 2 / SAMPLE_RATE > MAX_STREAM_S:
            raise HTTPException(413, f"Dictation is limited to {MAX_STREAM_S // 60} minutes")
        found.append(pcm)
        return {"text": found.text(), "seconds": round(found.seconds, 2)}

    @app.post("/v1/stream/{stream_id}/finish")
    def stream_finish(stream_id: str) -> dict:
        found = session(stream_id)
        with sessions_lock:
            sessions.pop(stream_id, None)
        started = time.monotonic()
        try:
            text = found.finish()
        except Exception:
            raise HTTPException(500, "Transcription failed; see the plugin logs.") from None
        log.info(
            "stream %s finished: %.1fs of audio, final wait %.2fs (%d chars)",
            stream_id, found.seconds, time.monotonic() - started, len(text),
        )
        return {"text": text, "seconds": round(found.seconds, 2)}

    @app.delete("/v1/stream/{stream_id}")
    def stream_cancel(stream_id: str) -> dict:
        with sessions_lock:
            found = sessions.pop(stream_id, None)
        if found is not None:
            found.cancel()
        return {"ok": True}

    return app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        stream=sys.stdout,
    )
    args = parse_args()
    if args.watch_stdin:
        watch_stdin()
    app = build_app(args)

    import uvicorn

    log.info("listening on http://%s:%d", args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()

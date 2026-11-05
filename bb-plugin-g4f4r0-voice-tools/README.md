# Voice tools

Fast dictation for bb. Voice tools replaces bb's microphone with one that transcribes
while you talk, so the text is in your draft moments after you stop, even after a long
dictation. Speech is recognized on this machine (NVIDIA Parakeet or Whisper) or by
OpenRouter.

## Install

```sh
bb plugin install <path-to-this-folder> --yes
bb settings ai-services set voice voice-tools --plugin voice-tools
```

The second command makes bb's mobile apps and `bb voice transcribe` use Voice tools
too. The first local install downloads about 200 MB of speech engines and the model
(670 MB for Parakeet v3); `bb voice-tools status` shows its progress.

## Dictate

- **Desktop and web:** click the mic in any composer, or press `Mod+Shift+D`. It looks
  and works like bb's own mic. Text appears in the draft as you speak; Stop adds the
  last words, Cancel removes what the dictation wrote, Send submits. Up to 20 minutes.
- **Mobile apps:** bb's mobile mic records first and sends the recording when you
  stop, so the wait grows with its length (about 1 s per 10 s of speech on a 16-core
  CPU without a GPU).

## Settings

Settings → Plugins → Voice tools has four rows:

| Setting | Options | Default |
|---|---|---|
| Source | This machine (private, free) or OpenRouter (fastest, sends audio to OpenRouter) | This machine |
| Model | This machine: Parakeet v3, Whisper small, Whisper large v3 turbo. OpenRouter: Voxtral Mini Transcribe 3, Parakeet v3, Whisper large v3 turbo, ElevenLabs Scribe v2 | Parakeet v3 / Voxtral Mini Transcribe 3 |
| OpenRouter API key | Shown for OpenRouter only. Save checks the key with OpenRouter first. Stored in a 0600 file on the bb server, never sent to the browser. | none |
| Language | Detect automatically, or one of 16 languages | Detect automatically |

Each source remembers its own model. In OpenRouter mode the local speech server is
stopped, so it uses no memory or CPU. The local model always stays loaded.

Timed on a 9 s clip through OpenRouter (Nov 2026): Voxtral Mini Transcribe 3 0.5-0.7 s,
Whisper large v3 turbo 0.8-1.1 s, Parakeet v3 0.9-1.3 s, ElevenLabs Scribe v2 1.2-1.4 s.

## Command line

| Command | What it does |
|---|---|
| `bb voice-tools status` | What transcribes, whether it's ready, and where its files are |
| `bb voice-tools restart` | Restart the local speech server (reloads the model) |
| `bb voice-tools reinstall` | Rebuild the local Python environment, then start again |
| `bb voice-tools logs` | Install and server logs, including each recording's length and last words |

## Resources

Measured on a 16-vCPU Linux VM without a GPU, local mode with Parakeet v3:

| | RAM | Disk |
|---|---|---|
| Local, model loaded | about 1.1 GB | about 1.1 GB (model 640 MB, Python environment 400 MB) |

| OpenRouter | none (server stopped) | same, until you uninstall |

Idle CPU is near zero. Whisper's engine (about 150 MB) is installed only while a
Whisper model is selected, and switching models deletes the old model's files.

## How it works

- `app.tsx`, `src/dictation.ts`: the composer mic, built from bb's own
  `experimental_VoiceInputButton` and `experimental_VoiceRecordingBar`. It captures the
  microphone, downsamples to 16 kHz mono in the browser, sends about one second at a
  time, and writes each recognized piece into the draft. Also the settings status.
- `server.ts`: the `config.*` and `dictation.*` RPC, the API key store, the `voice-tools` voice service for
  whole recordings, the CLI, and a loop that keeps the local server running in local
  mode and stopped in cloud mode.
- `src/config.ts`: sources, model lists, languages.
- `src/cloud.ts`: the OpenRouter client and cloud live dictation.
- `host.ts`, `src/supervisor.ts`: on the bb machine, download a checksummed `uv`,
  build a private Python 3.12 environment, and supervise `python/speech_server.py`.
- `python/speech_server.py`: decodes uploads with PyAV (no system ffmpeg), runs the
  model, and serves `/v1/audio/transcriptions` and `/v1/stream`.

Dictation is cut where the speaker pauses (at least 0.6 s of silence), at a pause after
6 s (8 s in the cloud), or at the quietest point once a piece gets long. Each piece gets
a little silence before and after, so the model doesn't drop a first or last word.
Pieces without speech are skipped.

## Platforms

Local mode runs on Linux x64 and arm64, macOS (Apple silicon and Intel) and Windows
x64; it has been tested end to end on Linux x64 only. Windows on ARM can't run the local
engines; use OpenRouter there.

## Develop

```sh
npm install
npm test && npm run build
bb plugin reload voice-tools
```

Forked from [bb-plugin-gigaam](https://github.com/AiXenix/bb-plugin-gigaam) (MIT).

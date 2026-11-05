# Voice tools

Fast, accurate dictation for bb. Voice tools replaces bb's microphone and transcribes
on this machine (NVIDIA Parakeet or Whisper) or with OpenRouter. Audio uploads while
you talk, so the text is in your draft about half a second after you stop, even after
a long dictation.

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
  and works like bb's own mic: ✕ cancels, ✓ adds the text. Up to 20 minutes.
- **Mobile apps:** bb's mobile mic sends the whole recording when you stop. With
  OpenRouter that takes about 1-2 s for a minute of speech and 3 s for three minutes.

## Settings

Settings → Plugins → Voice tools:

| Setting | Options | Default |
|---|---|---|
| Source | This machine (private, free) or OpenRouter (fastest, sends audio to OpenRouter) | This machine |
| Model | This machine: Parakeet v3, Whisper small, Whisper large v3 turbo. OpenRouter: Voxtral Mini Transcribe 3, Parakeet v3, ElevenLabs Scribe v2 | Parakeet v3 / Voxtral Mini Transcribe 3 |
| OpenRouter API key | Shown for OpenRouter only. Save checks the key with OpenRouter first. Stored in a 0600 file on the bb server, never sent to the browser. | none |
| Microphone | System default or a microphone this browser can see; per browser | System default |
| Language | Detect automatically, or one of 16 languages | Detect automatically |

Each source remembers its own model. In OpenRouter mode the local speech server is
stopped, so it uses no memory or CPU. The local model always stays loaded.

### Choosing a cloud model

Benchmarked on OpenRouter in Nov 2026: 10 Spanish clips (Multilingual LibriSpeech) and
10 English clips (LibriSpeech test-clean), word error rate and median time per clip.

| Model | Spanish | English | Time |
|---|---|---|---|
| Voxtral Mini Transcribe 3 | 1.2% | 0.4% | 0.7-0.8 s |
| Parakeet v3 | 1.7% | 0.8% | 0.8-1.2 s |
| ElevenLabs Scribe v2 | 1.2% | 0.8% | 1.2-1.4 s |
| Whisper large v3 turbo (not offered) | 11.9% | 0.4% | 1.4-2.1 s |

Voxtral is the most accurate and among the fastest, but times out on recordings over
about 50 s. Composer dictation never sends it more than 40 s at once, and long phone
recordings go to Parakeet, which transcribed three minutes in about 4 s.

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
  time, and inserts the transcript when you stop. Also the settings page.
- `server.ts`: the `config.*` and `dictation.*` RPC, the API key store, the `voice-tools` voice service for
  whole recordings, the CLI, and a loop that keeps the local server running in local
  mode and stopped in cloud mode.
- `src/config.ts`: sources, model lists, languages.
- `src/cloud.ts`: the OpenRouter client and cloud live dictation.
- `host.ts`, `src/supervisor.ts`: on the bb machine, download a checksummed `uv`,
  build a private Python 3.12 environment, and supervise `python/speech_server.py`.
- `python/speech_server.py`: decodes uploads with PyAV (no system ffmpeg), runs the
  model, and serves `/v1/audio/transcriptions` and `/v1/stream`.

Most dictations are transcribed in one go when you stop, which keeps whole sentences
together. A dictation longer than 20 s is cut at its longest pause (at least 0.5 s),
or at the quietest point by 40 s, and finished pieces are transcribed in the
background. Each piece gets a little silence before and after, so the model doesn't
drop a first or last word. Pieces without speech are skipped.

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

---
name: tts
description: Local text-to-speech via sherpa-onnx-tts or online TTS APIs
version: "1.0.0"
category: capability
openclaw:
  format-version: "1.0"
  emoji: "🔊"
  compatibility:
    - nanoclaw
    - oxiclaw
  requires:
    bins:
      - sherpa-onnx-tts
      - espeak
      - say
  install:
    - kind: "brew"
      formula: "sherpa-onnx"
    - kind: "brew"
      formula: "espeak"
---

# Text to Speech

Use local TTS engines for speech generation. sherpa-onnx-tts provides high-quality neural TTS, espeak is lightweight, and `say` is available on macOS.

## sherpa-onnx-tts (Recommended)

High-quality neural TTS with on-device inference.

```bash
# List available models
sherpa-onnx-tts --help

# Basic usage
sherpa-onnx-tts \
  --model /path/to/model.onnx \
  --tokens /path/to/tokens.txt \
  --input "Hello, this is a test."

# With speaker selection (for multi-speaker models)
sherpa-onnx-tts \
  --model /path/to/model.onnx \
  --tokens /path/to/tokens.txt \
  --speaker 0 \
  --input "Hello world"

# Save to file
sherpa-onnx-tts \
  --model /path/to/model.onnx \
  --tokens /path/to/tokens.txt \
  --input "Hello world" \
  --output /tmp/hello.wav
```

### Downloading Models

Sherpa-onnx provides pre-trained models:
```bash
# Example: downloading a English model
curl -L -o model.onnx "https://huggingface.co/csukuangfj/sherpa-onnx-vits-zh-hf/raw/main/vits-xuan-xuan/model.onnx"
curl -L -o tokens.txt "https://huggingface.co/csukuangfj/sherpa-onnx-vits-zh-hf/raw/main/vits-xuan-xuan/tokens.txt"
```

## espeak (Lightweight)

Simple, cross-platform TTS:

```bash
# Basic usage
espeak "Hello world"

# Save to file
espeak -w /tmp/hello.wav "Hello world"

# Change voice
espeak -v en-us "Hello world"
espeak -v female "Hello world"

# Adjust speed (words per minute)
espeak -s 150 "Hello world"
```

## macOS say Command

Built-in macOS TTS:

```bash
# List voices
say -v "?"

# Basic usage
say "Hello world"

# Save to file
say -o /tmp/hello.aiff "Hello world"

# Use specific voice
say -v Samantha "Hello world"
```

## Pipeline: TTS + Telegram Delivery

To generate speech and send via Telegram:

```bash
# 1. Generate speech
sherpa-onnx-tts \
  --model /path/to/model.onnx \
  --tokens /path/to/tokens.txt \
  --input "Your message here" \
  --output /tmp/tts_output.wav

# 2. Send to Telegram
telegram-send --file /tmp/tts_output.wav --chat-id YOUR_CHAT_ID
```

Or using `tg`:
```bash
tg -W YOUR_CHAT_ID -f /tmp/tts_output.wav
```

## Usage Examples

### Quick TTS on macOS
```bash
say "The build is complete. All tests passed."
```

### Local neural TTS with Sherpa
```bash
sherpa-onnx-tts \
  --model ./models/vits-english/model.onnx \
  --tokens ./models/vits-english/tokens.txt \
  --input "$TEXT" \
  --output /tmp/speech.wav
```

### TTS with espeak for fast preview
```bash
espeak -w /tmp/preview.wav "Preview text" && \
telegram-send --file /tmp/preview.wav
```

## Tips

- **Quality:** sherpa-onnx-tts > say > espeak (neural vs concatenative vs formant)
- **Speed:** espeak is fastest, sherpa-onnx-tts varies by model size
- **Offline:** espeak and sherpa-onnx-tts work fully offline; say requires macOS
- **Voice selection:** Use `say -v "?"` to see all available macOS voices

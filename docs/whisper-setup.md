# Whisper voice-to-text setup

Claudia supports whisper.cpp as a local, private alternative to Deepgram.
Run these steps on the machine that hosts Claudia (e.g. the Colima VM).

## Install

```bash
sudo apt-get install -y build-essential git ffmpeg
git clone https://github.com/ggerganov/whisper.cpp
cd whisper.cpp
make -j$(nproc)
bash models/download-ggml-model.sh base.en
```

Model options — `base.en` is the practical sweet spot:

| Model | Size | Latency (CPU) |
|-------|------|---------------|
| tiny.en | 75 MB | ~0.5 s |
| base.en | 150 MB | ~1 s |
| small.en | 500 MB | ~3 s |

## Run

```bash
./server -m models/ggml-base.en.bin --host 0.0.0.0 --port 8080
```

## Run as a systemd service (optional)

```ini
# /etc/systemd/system/whisper.service
[Unit]
Description=whisper.cpp inference server
After=network.target

[Service]
WorkingDirectory=/home/aaron/whisper.cpp
ExecStart=/home/aaron/whisper.cpp/server -m models/ggml-base.en.bin --host 0.0.0.0 --port 8080
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now whisper
```

## Configure Claudia

Settings → Dictate → Whisper → Server URL: `http://localhost:8080`

## Notes

- Audio is transcribed in ~5 s chunks (no streaming). Expect ~1–2 s latency after you stop speaking.
- Fully offline and private — no data leaves the machine.
- The Claudia hook sends `language=en` and expects `{ "text": "..." }` in the response, which is whisper.cpp's default format.

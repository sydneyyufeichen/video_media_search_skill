#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y ffmpeg python3-venv
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip wheel
.venv/bin/pip install --index-url https://download.pytorch.org/whl/cu124 torch
.venv/bin/pip install qwen-asr requests
.venv/bin/python -c 'import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))'

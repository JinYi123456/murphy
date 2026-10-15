# MURPHY batched engine on AMD Instinct.
#
# Base image: the official ROCm PyTorch container, which already carries a torch
# built against HIP. Tag as published at the time of writing (see
# https://rocm.docs.amd.com/projects/ai-ecosystem/en/latest/frameworks/pytorch/install.html):
#
#     rocm/pytorch:rocm10.1.0_ubuntu24.04_py3.12_pytorch_release_2.14.0
#
# If that tag is not on your host, `docker images rocm/pytorch` and use the
# newest one; the kernel needs a torch with float64 on device and nothing else.
#
# Build from the REPOSITORY ROOT, because the engine reads its configuration from
# data/ (procedures, plants, personas, costs) and the gate reads data/golden:
#
#     docker build -f services/gpu/Dockerfile -t murphy-gpu .
#
# Run it with the devices exposed - without these flags torch sees no GPU and the
# service will honestly report itself as CPU-only:
#
#     docker run -d --name murphy-gpu \
#       --device /dev/kfd --device /dev/dri \
#       --ipc=host --group-add video \
#       --cap-add SYS_PTRACE --security-opt seccomp=unconfined \
#       -p 8000:8000 murphy-gpu
#
# /dev/kfd is the compute driver, /dev/dri is the render nodes (one per GPU),
# --ipc=host shares the System V IPC namespace the ROCm runtime uses for its
# queues, and the video group is what grants access to those nodes.
#
# Then point the console at it:  AMD_GPU_URL=http://<host>:8000  in the app's .env.

FROM rocm/pytorch:rocm10.1.0_ubuntu24.04_py3.12_pytorch_release_2.14.0

# the engine is data-adjacent by design: the same JSON the TypeScript reads
COPY data /app/data
COPY services/gpu /app/services/gpu

WORKDIR /app/services/gpu

RUN python -m pip install --no-cache-dir -r requirements.txt

# the kernel is float64 tensor arithmetic; the batch size, not the model, decides
# how much device memory a request wants, so no CUDA/HIP caches are baked in
ENV PYTHONUNBUFFERED=1 \
    HIP_LAUNCH_BLOCKING=0 \
    MURPHY_GPU_DEVICE=cuda

EXPOSE 8000

# python rather than curl: the base image is not guaranteed to carry curl
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health')); print(d.get('device'), d.get('hip'))"

CMD ["python", "-m", "uvicorn", "murphy_gpu.api:app", "--host", "0.0.0.0", "--port", "8000"]

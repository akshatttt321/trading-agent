FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY agent ./agent
COPY scripts ./scripts
COPY watchdog ./watchdog
COPY config.yaml .
ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "agent.main"]

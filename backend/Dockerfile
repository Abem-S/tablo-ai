FROM python:3.12-slim

WORKDIR /app

# System deps for PyMuPDF and other native packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    libmupdf-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Create data directories
RUN mkdir -p data/uploads data/learner_profiles

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]

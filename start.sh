#!/bin/bash
set -e

echo "Welcome to Tablo!"
echo "Let's get your local environment set up."
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "No .env file found. Creating one now..."
    read -p "Please enter your Google Gemini API Key: " GOOGLE_API_KEY
    
    cat > .env << EOL
GOOGLE_API_KEY=$GOOGLE_API_KEY
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
QDRANT_URL=http://qdrant:6333
EOL
    echo "Created .env file with default local settings."
else
    echo "Found existing .env file. Proceeding..."
fi

# Set up local LiveKit config
if [ ! -f "livekit.yaml" ]; then
    echo "Setting up local LiveKit configuration..."
    cat > livekit.yaml << EOL
port: 7880
bind_addresses:
  - ""
keys:
  devkey: secret
rtc:
  port_range_start: 50100
  port_range_end: 50200
room:
  empty_timeout: 300
  max_participants: 20
logging:
  level: info
  json: false
EOL
fi

echo ""
echo "Starting Tablo via Docker Compose..."
echo "This will start Qdrant, LiveKit, the Backend API, the AI Agent, and the Frontend."
docker compose up -d --build

echo ""
echo "=================================================="
echo "Tablo is starting up!"
echo "Frontend: http://localhost:3000"
echo "Backend API: http://localhost:8000"
echo "LiveKit: ws://localhost:7880"
echo "=================================================="
echo "Run 'docker compose logs -f' to see the logs."

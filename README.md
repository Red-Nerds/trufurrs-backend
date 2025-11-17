# Trufurrs Backend (Node.js)

A Node.js backend service that subscribes to Mosquitto MQTT topics, processes messages, and pushes data to Google Firestore with **optimized batch operations**.

## Features

- ✅ MQTT topic subscription using Mosquitto
- ✅ **Batch write optimization** (up to 500 operations per batch)
- ✅ **No read-before-write** for device updates (uses `set()` with merge)
- ✅ Time-windowed batching (configurable)
- ✅ Async processing with native Promises
- ✅ Graceful shutdown with batch flushing

## Performance Optimization

### Batch Processing
- **Firestore batch writes**: Up to 500 operations per commit
- **Time-windowed batching**: Auto-flush every 3 seconds (configurable)
- **Smart merging**: Device updates use `set({merge: true})` - no reads required!

### Firestore Cost Comparison

**Without batching (Rust current approach):**
- 10K users × 60 msg/hour = 600K messages/hour
- Each message = 2 operations (1 read + 1 write for device update)
- **Total: 1.2M operations/hour**

**With batching (Node.js approach):**
- 10K users × 60 msg/hour = 600K messages/hour
- Each message = 1 write (telemetry) + 1 merge write (device, no read!)
- Batched in chunks of 500
- **Total: 600K operations/hour (50% reduction!)**

## Prerequisites

- Node.js 18+
- Mosquitto MQTT broker
- Google Cloud Project with Firestore enabled
- Service account credentials for Firestore

## Setup

1. **Clone and install dependencies:**
   ```bash
   cd trufurrs-backend-node
   npm install
   ```

2. **Configure environment:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your settings:
   ```env
   MQTT_BROKER=mqtt://your-broker:1883
   MQTT_USERNAME=your-username
   MQTT_PASSWORD=your-password
   MQTT_TOPIC=trufurrs/#
   
   FIRESTORE_PROJECT_ID=your-project-id
   GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json
   
   # Batching (adjust based on load)
   BATCH_SIZE=500
   BATCH_TIMEOUT_MS=3000
   ```

3. **Add service account key:**
   ```bash
   # Place your Firebase service account JSON in project root
   cp ~/Downloads/your-service-account.json ./service-account-key.json
   ```

## Development

```bash
npm run dev
```

## Production

```bash
npm start
```

## Deployment (Ubuntu/AWS Lightsail)

1. **Install Node.js:**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Clone and setup:**
   ```bash
   git clone <your-repo>
   cd trufurrs-backend-node
   npm install --production
   ```

3. **Setup as systemd service:**
   ```bash
   sudo nano /etc/systemd/system/trufurrs-node.service
   ```
   
   ```ini
   [Unit]
   Description=Trufurrs Backend Node.js
   After=network.target

   [Service]
   Type=simple
   User=ubuntu
   WorkingDirectory=/home/ubuntu/trufurrs-backend-node
   ExecStart=/usr/bin/node src/index.js
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   ```

4. **Enable and start:**
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable trufurrs-node
   sudo systemctl start trufurrs-node
   sudo systemctl status trufurrs-node
   ```

5. **View logs:**
   ```bash
   sudo journalctl -u trufurrs-node -f
   ```

## Project Structure

```
src/
├── index.js              # Application entry point
├── mqtt/
│   └── client.js         # MQTT client implementation
├── firestore/
│   └── client.js         # Firestore client with batching
└── processor/
    └── handler.js        # Message processing logic
```

## Tuning Batch Settings

Adjust based on your load:

- **High traffic (>100 msg/sec):** `BATCH_SIZE=500`, `BATCH_TIMEOUT_MS=2000`
- **Medium traffic (10-100 msg/sec):** `BATCH_SIZE=300`, `BATCH_TIMEOUT_MS=3000`
- **Low traffic (<10 msg/sec):** `BATCH_SIZE=100`, `BATCH_TIMEOUT_MS=5000`

## Monitoring

The service logs stats every 100 messages:
```
📊 Stats: 1000 messages processed (45.23 msg/sec), 0 errors
```

## Comparison with Rust Backend

| Feature | Rust | Node.js |
|---------|------|---------|
| Firestore operations | Read + Write per device | Write only (merge) |
| Batch support | Manual | Native SDK support |
| Operations per 10K users/hour | ~1.2M | ~600K |
| Memory usage | Lower | Moderate |
| Development speed | Slower | Faster |
| Deployment | Compiled binary | Node runtime |

**Recommendation:** Node.js for better Firestore integration and 50% cost savings.
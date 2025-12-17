# Trufurrs Backend - Technical Documentation

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Technology Stack](#technology-stack)
4. [Data Flow](#data-flow)
5. [Firestore Database Structure](#firestore-database-structure)
6. [Performance Optimization](#performance-optimization)
7. [Alert System](#alert-system)
8. [Performance Monitoring](#performance-monitoring)
9. [Installation & Setup](#installation--setup)
10. [Deployment](#deployment)
11. [Maintenance & Operations](#maintenance--operations)
12. [Cost Management](#cost-management)
13. [Troubleshooting](#troubleshooting)
14. [Future Enhancements](#future-enhancements)

---

## Overview

The Trufurrs Backend is a Node.js service that processes real-time telemetry data from IoT pet tracking devices via MQTT and stores it efficiently in Google Firestore. The system is designed to handle high-throughput data processing (600K+ messages/hour) while maintaining cost efficiency through intelligent batching and optimized database operations.

### Key Features

- **Real-time MQTT Processing**: Subscribes to Mosquitto MQTT broker topics for live telemetry data
- **Intelligent Batch Processing**: Groups Firestore operations (up to 500 per batch) to reduce costs by 50%
- **Multi-Device Support**: Handles three device types (Tag, Active, Sense) with different capabilities
- **Smart Alert System**: Deduplicates and manages location and battery alerts in real-time
- **Performance Monitoring**: Tracks operations, costs, and system performance metrics
- **Date-Partitioned Storage**: Organizes telemetry data by device and date for efficient querying
- **Location Tracking**: Maintains live location, historical tracks, and location history arrays

### System Capacity

- **Current**: 10,000 devices @ 60 messages/hour/device = 600K messages/hour
- **Scalable to**: 100K+ devices with current architecture
- **Cost**: ~$0.18/day for 10K devices (vs $3,100/month with naive implementation)
---

## System Architecture

```

┌─────────────────┐
│  IoT Devices    │
│  (Tag/Active/   │
│   Sense)        │
└────────┬────────┘
         │ MQTT Messages
         │ (60/hour/device)
         ▼
┌─────────────────┐
│ Mosquitto MQTT  │
│     Broker      │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│         Trufurrs Backend (Node.js)          │
│                                             │
│  ┌──────────────┐    ┌──────────────┐     │
│  │ MQTT Client  │───▶│  Message     │     │
│  │              │    │  Processor   │     │
│  └──────────────┘    └──────┬───────┘     │
│                             │              │
│                             ▼              │
│                      ┌──────────────┐      │
│                      │ Alert System │      │
│                      └──────┬───────┘      │
│                             │              │
│                             ▼              │
│                      ┌──────────────┐      │
│                      │  Batch Queue │      │
│                      │  (500 ops)   │      │
│                      └──────┬───────┘      │
│                             │              │
│                             ▼              │
│                      ┌──────────────┐      │
│                      │  Firestore   │      │
│                      │   Client     │      │
│                      └──────┬───────┘      │
│                             │              │
│  ┌──────────────────────────┴──────┐      │
│  │   Performance Monitor           │      │
│  │   - Operation Tracking          │      │
│  │   - Cost Estimation             │      │
│  │   - Daily Reports               │      │
│  └─────────────────────────────────┘      │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ Google Firestore│
│                 │
│ Collections:    │
│ - devices       │
│ - telemetry_*   │
│ - alerts        │
└─────────────────┘

```

---

## Technology Stack

### Core Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| Node.js | 18+ | Runtime environment |
| @google-cloud/firestore | ^8.0.0 | Firestore SDK with native batching |
| mqtt | ^5.14.1 | MQTT client library |
| dotenv | ^17.2.3 | Environment configuration |

### Why Node.js?

1. **Native Firestore Batching**: Built-in batch operations (500 ops/commit)
2. **No Read-Before-Write**: `set({merge: true})` eliminates redundant reads
3. **50% Cost Reduction**: 600K ops/hour vs 1.2M ops/hour
4. **Rapid Development**: Faster iteration vs compiled languages
5. **Excellent Async Support**: Native promises for concurrent operations
---

## Data Flow

### 1. Message Reception

```

MQTT Topic: trufurrs/{tag_type}/telemetry
Example: trufurrs/active/telemetry

```

**Payload Structure:**

```
{
  "device_id": "DEV001",
  "firmware_version": "1.0.0",
  "pet_id": "PET123",
  "user_id": "USER456",
  "alert_id": "ALT-LOC-001",
  "location": {
    "GPS_signal": "strong",
    "longitude": 77.5946,
    "latitude": 12.9716,
    "altitude": 920.5,
    "timestamp": "2025-01-15T10:30:00Z"
  },
  "activity": {
    "acc_x": 0.12, "acc_y": 0.45, "acc_z": 9.8,
    "gyro_x": 0.01, "gyro_y": 0.02, "gyro_z": 0.03,
    "temperature": 25.5
  },
  "compass": {
    "heading_degrees": 45,
    "direction": "NE"
  },
  "device": {
    "battery_level": 85.0,
    "heartbeat": 1.0
  },
  "fence": {
    "fence_id": "FENCE001",
    "status": "inside",
    "center_lat": 12.9716,
    "center_lon": 77.5946,
    "radius_m": 100.0,
    "distance_m": 25.5
  }
}
```

### 2. Message Processing Flow

```
MQTT Message Received
    ↓
Extract tag_type from topic
    ↓
Parse & Validate JSON payload
    ↓
Add created_at timestamp
    ↓
Check for alerts (alert_id present?)
    ↓
    ├─→ YES: Process Alert
    │        ├─→ Check if unresolved alert exists
    │        ├─→ Create alert if needed
    │        └─→ Skip if duplicate
    │
    └─→ NO: Continue
    ↓
Queue telemetry for batch processing
    ↓
    ├─→ Queue < 500? Wait for timeout (3s)
    └─→ Queue = 500? Force flush immediately
    ↓
Batch Commit to Firestore
    ↓
Update Performance Metrics

```

### 3. Batch Processing Strategy

**Queue Management:**

- **Batch Size**: 500 operations (Firestore limit)
- **Timeout: 3 seconds (configurable)
- **Auto-Flush: Triggered when queue reaches 500 or timeout expires

**Operations per Message:**

- **Telemetry Write**: Store in date-partitioned collection
- **Device Update**: Update live location (merge, no read)
- **Track Point**: Add to daily track subcollection
- **Location History**: Append to array (max 50 points)
- **Metadata Updates**: Track points count per day
---

## Firestore Database Structure

### Collection Hierarchy

```

firestore (root)
│
├── devices/
│   ├── {device_id}/
│   │   ├── liveLocation (map)
│   │   ├── locationHistory (array[50])
│   │   ├── lastUpdated (timestamp)
│   │   │
│   │   ├── tracks/ (subcollection)
│   │   │   ├── {YYYYMMDD}/ (track date)
│   │   │   │   ├── date, startTime, endTime, pointsCount
│   │   │   │   │
│   │   │   │   └── points/ (subcollection)
│   │   │   │       ├── {timestamp}/ (track point)
│   │   │   │       │   ├── latitude, longitude, altitude
│   │   │   │       │   ├── GPS_signal, battery_level
│   │   │   │       │   ├── heading, direction
│   │   │   │       │   └── timestamp, createdAt
│   │   │   │
│   │   └── alerts/ (subcollection)
│   │       ├── {auto_id}/ (alert document)
│   │       │   ├── userId, petId, deviceId
│   │       │   ├── alertType, title, message
│   │       │   ├── severity, priority
│   │       │   ├── isRead, isResolved
│   │       │   ├── createdAt, readAt, resolvedAt
│   │       │   ├── location (map)
│   │       │   └── alertIdType, geofenceId
│
├── telemetry_tag/ (Tag devices)
│   ├── {device_id}/
│   │   ├── {YYYYMMDD}/ (telemetry date)
│   │   │   │
│   │   │   └── points/ (subcollection)
│   │   │       ├── {timestamp}/ (telemetry point)
│   │   │       │   ├── device_id, tag_type
│   │   │       │   ├── firmware_version
│   │   │       │   ├── pet_id, user_id, alert_id
│   │   │       │   ├── location (map)
│   │   │       │   ├── activity (map)
│   │   │       │   ├── compass (map)
│   │   │       │   ├── device (map)
│   │   │       │   ├── fence (map)
│   │   │       │   ├── created_at
│   │   │       │   └── processed_at (tag only)
│   │   │
│   │   └── metadata/ (subcollection)
│   │       ├── {YYYYMMDD}/ (metadata for date)
│   │       │   ├── deviceId, collection, date
│   │       │   ├── startTime, endTime
│   │       │   ├── pointsCount, createdAt
│
├── telemetry_active/ (Active devices)
│   └── (same structure as telemetry_tag)
│
└── telemetry_sense/ (Sense devices)
    └── (same structure as telemetry_tag)

```

### Key Design Decisions

#### 1. Date Partitioning

**Path**: `telemetry_{type}/{device_id}/{YYYYMMDD}/points/{timestamp}`
**Benefits:**
- Efficient querying by date range
- Natural data lifecycle management
- Simplified archival to S3 (move old dates)
- Better query performance

#### 2. Device Document Structure

```javascript

devices/{device_id}
{
  "liveLocation": {
    "GPS_signal": "strong",
    "altitude": 920.5,
    "latitude": 12.9716,
    "longitude": 77.5946,
    "timestamp": "2025-01-15T10:30:00Z"
  },
  "locationHistory": [
    { "lat": 12.9716, "lon": 77.5946, "alt": 920.5, "timestamp": "..." },
    // ... max 50 points
  ],
  "lastUpdated": "2025-01-15T10:30:15Z"
}
```

**Purpose:**

- `liveLocation`: Real-time tracking (mobile app displays this)
- `locationHistory`: Last 50 positions (recent movement visualization)
- Trimmed via maintenance job when exceeds 50 points

#### 3. Track Subcollections

**Path**: `devices/{device_id}/tracks/{YYYYMMDD}/points/{timestamp}`
**Benefits:**
- Complete historical path per day
- Metadata tracks points count per day
- Efficient queries for daily route playback
- Isolated from main device document

#### 4. Metadata Documents

**Purpose:** Track statistics without querying all points
```javascript

telemetry_active/DEV001/metadata/20250115
{
  "deviceId": "DEV001",
  "collection": "telemetry_active",
  "date": "20250115",
  "startTime": "2025-01-15T00:05:00Z",
  "endTime": "2025-01-15T23:58:00Z",
  "pointsCount": 1440,  // 60 msg/hour * 24 hours
  "createdAt": "2025-01-15T00:05:00Z"
}

```

---

## Performance Optimization

### 1. Batch Processing

**Strategy**: Accumulate operations and commit in batches of 500

**Implementation:**
```javascript
// Queue operations
telemetryQueue.push(telemetry);

// Auto-flush conditions:
if (queue.length >= 500) {
  await flushBatches();  // Immediate
} else if (!batchTimer) {
  batchTimer = setTimeout(() => flushBatches(), 3000);  // Delayed
}

```

**Cost Impact:**
| Metric | Without Batching | With Batching | Savings |
|--------|------------------|---------------|---------|
| Operations/hour | 1.2M | 600K | 50% |
| Daily cost (10K devices) | $6.48 | $3.24 | $3.24 |
| Monthly cost (10K devices) | $194 | $97 | $97 |

**Savings**: 50% reduction on device updates

### 2. Array Operations
**Location History Update:**

```javascript
// Efficient array union (Firestore native)
await deviceRef.update({
  locationHistory: FieldValue.arrayUnion(newPoint)
});
```

**Trimming Strategy:**

- Arrays grow beyond 50 points over time
- Separate maintenance job trims to last 50
- Runs daily or weekly (not real-time)
- See: `src/maintenance/trimLocationHistory.js`

### 4. Connection Pooling

Firestore SDK maintains connection pool automatically. No additional configuration needed.
---

## Alert System

### Alert Types (Phase 1 - Real-time)

**Location Alerts:**
- `ALT-LOC-001`: Out-of-Zone Alert (geofence exit)
- `ALT-LOC-002`: Re-Entry Notification (geofence re-entry)
- `ALT-LOC-003`: Auto-SOS on Fast Escape (critical)
- `ALT-LOC-004`: Low GPS Confidence
- `ALT-LOC-005`: No GPS Signal
- `ALT-LOC-006`: Device Not Connected

**Battery Alerts:**
- `ALR-BAT-001`: Battery Low (<20%)
- `ALR-BAT-002`: Battery Critical (<10%)
- `ALR-BAT-003`: Charging Complete

### Alert Processing Flow

```

Telemetry with alert_id received
    ↓
Check if alert_id is real-time (ALT-LOC-* or ALR-BAT-*)
    ↓
    ├─→ NO: Log and skip (will be processed by worker)
    └─→ YES: Continue
    ↓
Query existing unresolved alerts of same type
    ↓
    ├─→ EXISTS: Skip (deduplication)
    └─→ NOT EXISTS: Create new alert
    ↓
Get alert template from templates.js
    ↓
Interpolate values (e.g., {fence_id})
    ↓
Create alert document in devices/{device_id}/alerts/
    ↓
Record Firestore operations (1 read + 1 write)

```

### Deduplication Logic

**Purpose**: Prevent alert spam for same issue
**Implementation:**
```javascript
// Check for unresolved alerts
const snapshot = await alertsRef
  .where('alertIdType', '==', 'ALT-LOC-001')
  .where('isResolved', '==', false)
  .limit(1)
  .get();

if (!snapshot.empty) {
  // Skip - alert already exists
  return null;
}

// Create new alert
await alertsRef.doc().set(alertData);

```

### Alert Document Structure
```javascript
devices/DEV001/alerts/{auto_id}
{
  "userId": "USER456",
  "petId": "PET123",
  "deviceId": "DEV001",
  "geofenceId": "FENCE001",
  
  "alertType": "geofence",
  "alertIdType": "ALT-LOC-001",
  "title": "Out-of-Zone Alert",
  "message": "Device has exited the geofence FENCE001",
  "severity": "high",
  "priority": "high",
  
  "isRead": false,
  "isResolved": false,
  "createdAt": "2025-01-15T10:30:00Z",
  "readAt": null,
  "resolvedAt": null,
  
  "location": {
    "latitude": 12.9716,
    "longitude": 77.5946,
    "altitude": 920.5,
    "timestamp": "2025-01-15T10:30:00Z"
  },
  
  "actionUrl": null
}
```

---

## Performance Monitoring

### Real-time Metrics Tracked

**Counters:**
- Total messages processed
- Successful messages
- Failed messages
- Total batches committed
- Alerts created
- Alerts skipped (duplicates)

**Timing Metrics (Percentiles):**
- Message processing (end-to-end)
- Batch commit duration
- Alert processing time
- Queue wait time
- Location history updates
- Track metadata updates

**Queue Metrics:**
- Current queue size
- Average queue size
- Max queue size (P95, P99)

### Firestore Operations Tracking

**Daily Operations Breakdown:**
```javascript
{
  "date": "2025-01-15",
  "reads": 12500,
  "writes": 625000,
  "deletes": 0,
  "breakdown": {
    "telemetryWrites": 600000,
    "deviceWrites": 10000,
    "trackPointWrites": 600000,
    "locationHistoryWrites": 10000,
    "trackMetadataReads": 1200,
    "trackMetadataWrites": 1200,
    "telemetryMetadataReads": 1200,
    "telemetryMetadataWrites": 1200,
    "alertReads": 5000,
    "alertWrites": 3100
  },
  "estimatedCost": 3.24  // USD
}
```

**Cost Calculation:**
- Reads: $0.06 per 100K operations
- Writes: $0.18 per 100K operations
- Deletes: $0.02 per 100K operations

### Performance Reports

**Automatic Reports:**
- Every 100 messages: Quick stats
- On shutdown: Comprehensive final report

**Sample Report Output:**

```
================================================================================
📊 PERFORMANCE REPORT
================================================================================
📈 SUMMARY:
   Total Messages:     10000
   ✅ Successful:      9998
   ❌ Failed:          2
   📦 Total Batches:   21
   🚨 Alerts Created:  1250
   ⏭️  Alerts Skipped:  850
   ⏱️  Uptime:          3600.00s
   🔥 Current Rate:    45.23 msg/sec
   📊 Overall Rate:    2.78 msg/sec
💰 FIRESTORE OPERATIONS (Today):
   Date:               2025-01-15
   📖 Total Reads:     1,250
   ✍️  Total Writes:    62,500
   🗑️  Total Deletes:   0
   💵 Estimated Cost:  $0.32
⏱️  TIMING BREAKDOWN (ms):
   ----------------------------------------------------------------------------
   Operation                    | Avg    | P50    | P95    | P99    | Count
   ----------------------------------------------------------------------------
   Message Processing           | 12.45  | 10.23  | 25.67  | 45.89  | 10000
   Batch Commit                 | 234.56 | 221.34 | 456.78 | 678.90 | 21
   Alert Processing             | 15.67  | 12.45  | 34.56  | 56.78  | 2100
   ----------------------------------------------------------------------------

```

---

## Installation & Setup

### Prerequisites
- Node.js 18 or higher
- npm (comes with Node.js)
- Google Cloud Project with Firestore enabled
- Firebase service account key (JSON)
- Access to Mosquitto MQTT broker

### Local Development Setup

**1. Clone Repository**
```bash
git clone <repository-url>
cd trufurrs-backend-node
```

**2. Install Dependencies**
```bash
npm install
```

**3. Configure Environment**
```bash
cp .env.example .env
```

Edit `.env`:
```env

# MQTT Configuration
MQTT_BROKER=mqtt://your-broker-ip:1883
MQTT_USERNAME=your-mqtt-username
MQTT_PASSWORD=your-mqtt-password
MQTT_TOPIC=trufurrs/#

# Firestore Configuration
FIRESTORE_PROJECT_ID=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=./service-account-key.json

# Batch Processing (adjust based on load)
BATCH_SIZE=500
BATCH_TIMEOUT_MS=3000

# Logging
NODE_ENV=development
```

**4. Add Service Account Key**
```bash
# Download from Firebase Console → Project Settings → Service Accounts
# Save as service-account-key.json in project root
cp ~/Downloads/trufurrs-xxxxx.json ./service-account-key.json
```

**5. Run Development Server**
```bash
npm run dev
```

### Testing with MQTT

**Install MQTT Client:**
```bash
npm install -g mqtt
```

**Publish Test Message:**
```bash
mqtt pub \
  -h your-broker-ip \
  -u your-username \
  -P your-password \
  -t 'trufurrs/active/telemetry' \
  -m '{
    "device_id": "TEST001",
    "firmware_version": "1.0.0",
    "pet_id": "PET001",
    "user_id": "USER001",
    "alert_id": "",
    "location": {
      "GPS_signal": "strong",
      "longitude": 77.5946,
      "latitude": 12.9716,
      "altitude": 920.5,
      "timestamp": "2025-01-15T10:30:00Z"
    },
    "activity": {
      "acc_x": 0.12, "acc_y": 0.45, "acc_z": 9.8,
      "gyro_x": 0.01, "gyro_y": 0.02, "gyro_z": 0.03,
      "temperature": 25.5
    },
    "compass": {
      "heading_degrees": 45,
      "direction": "NE"
    },
    "device": {
      "battery_level": 85.0,
      "heartbeat": 1.0
    },
    "fence": {
      "fence_id": "FENCE001",
      "status": "inside",
      "center_lat": 12.9716,
      "center_lon": 77.5946,
      "radius_m": 100.0,
      "distance_m": 25.5
    }
  }'
```

---

## Deployment

### Production Environment (AWS Lightsail Ubuntu)

**System Requirements:**
- Ubuntu 20.04 LTS or higher
- 2GB RAM minimum
- 20GB storage
- Open port for MQTT (1883) if broker is external

### Deployment Steps
**1. Server Setup**
```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify installation
node --version  # Should be v18.x or higher
npm --version

```

**2. Deploy Application**
```bash
# Create application directory
sudo mkdir -p /opt/trufurrs-backend
sudo chown ubuntu:ubuntu /opt/trufurrs-backend

# Clone or upload code
cd /opt/trufurrs-backend
# (git clone or scp files here)

# Install production dependencies
npm install --production

# Upload configuration files
# - .env
# - service-account-key.json
```

**3. Create systemd Service**
```bash
sudo nano /etc/systemd/system/trufurrs-backend.service
```

**Service Configuration:**
```ini
[Unit]
Description=Trufurrs Backend Node.js Service
After=network.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/trufurrs-backend
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=trufurrs-backend

# Environment
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**4. Enable and Start Service**
```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable service (start on boot)
sudo systemctl enable trufurrs-backend

# Start service
sudo systemctl start trufurrs-backend

# Check status
sudo systemctl status trufurrs-backend
```

**5. Monitor Logs**
```bash
# Real-time logs
sudo journalctl -u trufurrs-backend -f

# Last 100 lines
sudo journalctl -u trufurrs-backend -n 100

# Today's logs
sudo journalctl -u trufurrs-backend --since today
```

### Using PM2 (Alternative)

**Install PM2:**
```bash
sudo npm install -g pm2
```

**Start Application:**
```bash
cd /opt/trufurrs-backend
pm2 start src/index.js --name trufurrs-backend

# Enable startup script
pm2 startup systemd
pm2 save
```

**PM2 Commands:**
```bash
pm2 status                    # Check status
pm2 logs trufurrs-backend     # View logs
pm2 restart trufurrs-backend  # Restart
pm2 stop trufurrs-backend     # Stop
pm2 delete trufurrs-backend   # Remove from PM2
```

### Firewall Configuration
```bash
# If MQTT broker is external
sudo ufw allow 1883/tcp
sudo ufw enable
```

---

## Maintenance & Operations

### Daily Operations

**1. Monitor Performance**
```bash
# Check service status
sudo systemctl status trufurrs-backend

# Check recent logs
sudo journalctl -u trufurrs-backend --since "1 hour ago"

# Look for errors
sudo journalctl -u trufurrs-backend -p err --since today
```

**2. Check Firestore Costs**
- Performance report logs daily cost estimates
- Monitor Firebase Console → Usage
- Alert if daily cost exceeds $5

### Weekly Maintenance

**1. Trim Location History Arrays**

Location history arrays grow beyond 50 points. Run trimming job:
```bash
cd /opt/trufurrs-backend
node src/maintenance/trimLocationHistory.js
```

**Schedule with Cron:**
```bash
crontab -e

# Add: Run every Sunday at 2 AM
0 2 * * 0 cd /opt/trufurrs-backend && /usr/bin/node src/maintenance/trimLocationHistory.js >> /var/log/trufurrs-trim.log 2>&1
```

**2. Archive Old Telemetry Data**

For data older than 90 days, consider archiving to S3:
```bash
# Example: Archive January 2025 data
# Export from Firestore → Upload to S3 → Delete from Firestore
```

### Monthly Maintenance

**1. Review Performance Metrics**
- Analyze historical daily reports
- Check for anomalies in operation counts
- Verify cost trends

**2. Update Dependencies**
```bash
# Check for updates
npm outdated

# Update (test in development first!)
npm update

# Security audit
npm audit
npm audit fix
```

**3. Database Cleanup**
- Delete resolved alerts older than 6 months
- Archive old telemetry data (>90 days)

### Backup Strategy

**Firestore Automatic Backups:**
```bash
# Configure in Firebase Console
# Settings → Backups → Enable automated backups
# Retention: 30 days
```

**Configuration Backup:**
```bash
# Backup .env and service account key
tar -czf trufurrs-config-$(date +%Y%m%d).tar.gz .env service-account-key.json
```

---

## Cost Management

### Current Cost Breakdown (10K Devices)

**Daily Operations:**
- Telemetry writes: 600,000 @ $0.18/100K = $1.08
- Device updates: 10,000 @ $0.18/100K = $0.018
- Track points: 600,000 @ $0.18/100K = $1.08
- Location history: 10,000 @ $0.18/100K = $0.018
- Metadata reads: 2,400 @ $0.06/100K = $0.014
- Metadata writes: 2,400 @ $0.18/100K = $0.043
- Alert reads: 5,000 @ $0.06/100K = $0.03
- Alert writes: 3,100 @ $0.18/100K = $0.056

**Total Daily**: ~$3.24
**Total Monthly**: ~$97

### Cost Optimization Strategies

**1. Batch Tuning**

Adjust batch settings based on load:
```env
# High traffic (>100 msg/sec)
BATCH_SIZE=500
BATCH_TIMEOUT_MS=2000

# Medium traffic (10-100 msg/sec)
BATCH_SIZE=300
BATCH_TIMEOUT_MS=3000

# Low traffic (<10 msg/sec)
BATCH_SIZE=100
BATCH_TIMEOUT_MS=5000
```

**2. Data Archival**

Move old data to cheaper storage:
| Storage | Cost (per GB/month) | Use Case |
|---------|---------------------|----------|
| Firestore | $0.18 | Active data (<30 days) |
| Cloud Storage | $0.02 | Archive (30-90 days) |
| Coldline | $0.004 | Long-term (>90 days) |

**3. Query Optimization**
- Use composite indexes for common queries
- Avoid queries without limits
- Use metadata documents for counts

**4. Alert Deduplication**
Current deduplication prevents ~40% duplicate alerts:
- Without: 5,000 alerts/day × $0.18/100K = $0.09
- With: 3,100 alerts/day × $0.18/100K = $0.056
- **Savings**: $0.034/day = $1.02/month

### Scaling Cost Projections

| Devices | Msg/Hour | Daily Ops | Daily Cost | Monthly Cost |
|---------|----------|-----------|------------|--------------|
| 10K | 600K | 1.2M writes | $3.24 | $97 |
| 25K | 1.5M | 3.0M writes | $8.10 | $243 |
| 50K | 3M | 6.0M writes | $16.20 | $486 |
| 100K | 6M | 12.0M writes | $32.40 | $972 |

---

## Troubleshooting

### Common Issues

**1. MQTT Connection Failures**

**Symptoms:**
```
❌ MQTT connection error: Connection refused
```

**Solutions:**
- Check MQTT broker is running: `sudo systemctl status mosquitto`
- Verify credentials in `.env`
- Check network connectivity: `telnet broker-ip 1883`
- Review broker logs: `sudo journalctl -u mosquitto -f`

**2. Firestore Write Errors**

**Symptoms:**
```
❌ Failed to write to Firestore: PERMISSION_DENIED
```

**Solutions:**
- Verify service account key has correct permissions
- Check Firestore security rules
- Ensure `GOOGLE_APPLICATION_CREDENTIALS` path is correct
- Verify project ID matches

**3. High Memory Usage**

**Symptoms:**
```
Process killed (OOM - Out of Memory)
```

**Solutions:**
- Reduce `BATCH_SIZE` (try 250 instead of 500)
- Increase server RAM
- Check for memory leaks in logs
- Monitor with: `pm2 monit`

**4. Batch Timeout Issues**

**Symptoms:**
```
⏳ Batch already processing, skipping...
```

**Solutions:**
- Increase `BATCH_TIMEOUT_MS` to 5000
- Reduce `BATCH_SIZE` to 300
- Check Firestore latency
- Review network connection to GCP

**5. Alert Duplicates**

**Symptoms:**
- Multiple alerts created for same issue

**Solutions:**
- Verify deduplication query is working
- Check alert index exists in Firestore
- Review alert resolution logic
- Check for race conditions in high load

### Debug Mode

**Enable Detailed Logging:**
```env
# In .env
NODE_ENV=development
```

**Check Specific Component:**
```javascript
// Temporarily add to src/index.js
console.log('DEBUG: Telemetry:', JSON.stringify(telemetry, null, 2));
```

### Performance Issues

**Slow Batch Commits:**
```bash
# Check Firestore latency
# Look for "Batch Commit" timing in performance reports
# If P95 > 500ms:
# 1. Check GCP region (should match Firestore location)
# 2. Verify network latency
# 3. Consider regional deployment
```

**High Queue Sizes:**
```bash
# If queue consistently > 400:
# 1. Reduce BATCH_TIMEOUT_MS
# 2. Check Firestore write capacity
# 3. Consider multiple backend instances
```

---

## Future Enhancements

### Planned Features

**1. Multi-Instance Deployment**
- Load balancing across multiple backend instances
- Horizontal scaling for 100K+ devices

**2. PostgreSQL Migration**
- Move telemetry data to PostgreSQL
- Keep Firestore for real-time features (devices, alerts)
- 92% cost reduction at scale
- Better analytics and reporting

**3. Advanced Alert System**
- Machine learning-based anomaly detection
- Predictive health alerts
- Custom user-defined geofences
- Alert escalation policies

**4. WebSocket Real-time Updates**
- Push location updates to mobile apps
- Live tracking without polling
- Reduced mobile app battery usage

**5. Data Analytics Pipeline**
- BigQuery integration for analysis
- Custom dashboards
- Pet behavior insights
- User engagement metrics

### Architecture Evolution

**Current**: Node.js → Firestore (All data)
**Phase 2**: Node.js → Firestore (Real-time) + PostgreSQL (Historical)
**Phase 3**: Node.js → Kafka → Multiple Consumers
- Consumer 1: Firestore (Real-time)
- Consumer 2: PostgreSQL (Historical)
- Consumer 3: Analytics (BigQuery)
- Consumer 4: Alert Engine (Redis)
---

## Contact & Support

### Red Nerds Team

- **Technical Lead**: Sahil (Head of Software Engineering)
- **Project**: TruFurrs Pet Tracking System

### Documentation Updates

This documentation should be updated when:
- Architecture changes are made
- New features are added
- Performance optimizations are implemented
- Deployment procedures change
- Cost structure changes

### Version History

- **v1.0** (Current): Node.js backend with batching and alerts
- **v0.1** (Deprecated): Rust backend prototype
---

## Appendix

### A. Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MQTT_BROKER` | Yes | - | MQTT broker URL (mqtt://host:port) |
| `MQTT_USERNAME` | Yes | - | MQTT authentication username |
| `MQTT_PASSWORD` | Yes | - | MQTT authentication password |
| `MQTT_TOPIC` | No | trufurrs/# | Topic to subscribe (# = wildcard) |
| `FIRESTORE_PROJECT_ID` | Yes | - | Google Cloud Project ID |
| `GOOGLE_APPLICATION_CREDENTIALS` | Yes | - | Path to service account JSON |
| `BATCH_SIZE` | No | 500 | Max operations per batch |
| `BATCH_TIMEOUT_MS` | No | 3000 | Batch flush timeout (ms) |
| `NODE_ENV` | No | production | Environment (development/production) |

### B. File Structure Reference

```
trufurrs-backend-node/
├── src/
│   ├── index.js                 # Main entry point
│   ├── mqtt/
│   │   └── client.js            # MQTT client
│   ├── firestore/
│   │   └── client.js            # Firestore client (batching)
│   ├── processor/
│   │   └── handler.js           # Message processor
│   ├── alerts/
│   │   └── templates.js         # Alert definitions
│   ├── monitoring/
│   │   └── performance.js       # Performance tracking
│   └── maintenance/
│       └── trimLocationHistory.js
├── package.json
├── .env.example
├── .env                         # (gitignored)
├── service-account-key.json     # (gitignored)
└── README.md
```

### C. Firestore Pricing Calculator
**Formula:**
```
Daily Cost = (Reads × 0.06 + Writes × 0.18 + Deletes × 0.02) / 100,000
```

**Example (10K devices, 60 msg/hour):**
```
Messages/day = 10,000 × 60 × 24 = 14,400,000
Operations/day ≈ 1,200,000 writes + 12,500 reads
Cost/day = (12,500 × 0.06 + 1,200,000 × 0.18) / 100,000
         = (750 + 216,000) / 100,000
         = $2.17/day ≈ $65/month
```

### D. Alert ID Reference
| Alert ID | Type | Severity | Real-time |
|----------|------|----------|-----------|
| ALT-LOC-001 | Geofence Exit | High | Yes |
| ALT-LOC-002 | Geofence Entry | Medium | Yes |
| ALT-LOC-003 | Fast Escape | Critical | Yes |
| ALT-LOC-004 | Low GPS | High | Yes |
| ALT-LOC-005 | No GPS | Medium | Yes |
| ALT-LOC-006 | Offline | Critical | Yes |
| ALR-BAT-001 | Low Battery | High | Yes |
| ALR-BAT-002 | Critical Battery | Critical | Yes |
| ALR-BAT-003 | Charging Done | Low | Yes |

---

**Document Version**: 1.0  
**Last Updated**: January 2025
**Prepared by**: Red Nerds Engineering Team
**Classification**: Confidential - Stakeholder Distribution

import { Firestore } from '@google-cloud/firestore';

export class FirestoreClient {
  constructor(projectId, batchSize = 500, batchTimeout = 3000) {
    this.db = new Firestore({
      projectId,
      ignoreUndefinedProperties: true,
    });

    this.batchSize = batchSize;
    this.batchTimeout = batchTimeout;

    // Queue for telemetry data
    this.telemetryQueue = [];

    this.batchTimer = null;
    this.isProcessing = false;

    console.log(`📦 Firestore batch config: size=${batchSize}, timeout=${batchTimeout}ms`);
  }

  /**
   * Add telemetry data to queue for batch processing
   */
  async queueTelemetry(telemetry) {
    this.telemetryQueue.push(telemetry);
    console.log(`📦 Queued telemetry (queue size: ${this.telemetryQueue.length})`);

    // Start batch timer if not already running
    if (!this.batchTimer) {
      console.log(`⏲️  Starting batch timer (${this.batchTimeout}ms)`);
      this.batchTimer = setTimeout(() => this.flushBatches(), this.batchTimeout);
    }

    // Force flush if queue reaches batch size
    if (this.telemetryQueue.length >= this.batchSize) {
      console.log(`🚨 Queue full (${this.telemetryQueue.length}), forcing flush...`);
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
      await this.flushBatches();
    }
  }

  /**
   * Flush all queued operations to Firestore in batches
   */
  async flushBatches() {
    if (this.isProcessing) {
      console.log('⏳ Batch already processing, skipping...');
      return;
    }

    const telemetryCount = this.telemetryQueue.length;

    if (telemetryCount === 0) {
      console.log('📭 Queue empty, nothing to flush'); // ADD THIS
      return;
    }

    this.isProcessing = true;
    this.batchTimer = null;

    console.log(`\n⏰ BATCH TIMEOUT TRIGGERED`); // ADD THIS

    try {
      // Process all items in chunks of batchSize
      const telemetryItems = [...this.telemetryQueue];

      // Clear queues immediately
      this.telemetryQueue = [];

      // Count unique devices for device updates
      const uniqueDevices = new Set(telemetryItems.map(t => t.device_id));
      const deviceUpdateCount = uniqueDevices.size;

      console.log(`🚀 Flushing batch: ${telemetryCount} telemetry + ${deviceUpdateCount} device updates`);

      // Combine operations and process in chunks
      await this.processBatchChunks(telemetryItems);

      console.log(`✅ Batch complete: ${telemetryCount + deviceUpdateCount} operations written to Firestore\n`); // ADD newline

    } catch (error) {
      console.error('❌ Batch flush error:', error);
      // Re-queue failed items
      this.telemetryQueue.push(...telemetryItems); // FIX: was pushing to itself
    } finally {
      this.isProcessing = false;

      // Restart timer if there are more items
      if (this.telemetryQueue.length > 0) {
        console.log(`🔄 Restarting timer, ${this.telemetryQueue.length} items in queue`); // ADD THIS
        this.batchTimer = setTimeout(() => this.flushBatches(), this.batchTimeout);
      }
    }
  }

  /**
   * Process operations in chunks of batchSize
   */
  async processBatchChunks(telemetryItems) {
    const allOperations = [];

    // Prepare telemetry operations
    for (const telemetry of telemetryItems) {
      const collection = this.getCollectionName(telemetry.tag_type);
      const timestampMillis = Date.now();
      const telemetryDocId = `${telemetry.device_id}_${timestampMillis}`;

      allOperations.push({
        type: 'telemetry',
        collection,
        docId: telemetryDocId,
        data: telemetry,
        deviceId: telemetry.device_id,
      });
    }

    // Group device updates by device_id (keep only latest per device)
    const deviceUpdates = new Map();
    const trackPoints = [];

    for (const telemetry of telemetryItems) {
      const locationPoint = {
        lat: telemetry.location.latitude,
        lon: telemetry.location.longitude,
        alt: telemetry.location.altitude,
        timestamp: telemetry.location.timestamp,
      };

      // Device update with live location
      deviceUpdates.set(telemetry.device_id, {
        type: 'device',
        collection: 'devices',
        docId: telemetry.device_id,
        data: {
          liveLocation: {
            GPS_signal: telemetry.location.GPS_signal,
            altitude: telemetry.location.altitude,
            latitude: telemetry.location.latitude,
            longitude: telemetry.location.longitude,
            timestamp: telemetry.location.timestamp,
          },
          // Update locationHistory - we'll handle trimming separately
          lastUpdated: new Date().toISOString(),
        },
        locationPoint: locationPoint, // For history array update
      });

      // Create track point for subcollection
      const today = new Date().toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
      const pointTimestamp = new Date(telemetry.location.timestamp).getTime();

      trackPoints.push({
        type: 'track_point',
        deviceId: telemetry.device_id,
        trackDate: today,
        pointId: pointTimestamp.toString(),
        data: {
          latitude: telemetry.location.latitude,
          longitude: telemetry.location.longitude,
          altitude: telemetry.location.altitude,
          GPS_signal: telemetry.location.GPS_signal,
          battery_level: telemetry.device.battery_level,
          heading: telemetry.compass?.heading_degrees || null,
          direction: telemetry.compass?.direction || null,
          timestamp: telemetry.location.timestamp,
          createdAt: new Date().toISOString(),
        }
      });
    }

    allOperations.push(...deviceUpdates.values());
    allOperations.push(...trackPoints);

    // Process in chunks of batchSize
    for (let i = 0; i < allOperations.length; i += this.batchSize) {
      const chunk = allOperations.slice(i, i + this.batchSize);
      await this.executeBatch(chunk);
    }

    // Update location history arrays (after batch commits)
    await this.updateLocationHistories(deviceUpdates);

    // Update track metadata (points count per day)
    const tracksByDate = new Map();
    for (const point of trackPoints) {
      const key = `${point.deviceId}_${point.trackDate}`;
      tracksByDate.set(key, {
        deviceId: point.deviceId,
        trackDate: point.trackDate,
        count: (tracksByDate.get(key)?.count || 0) + 1,
      });
    }

    for (const track of tracksByDate.values()) {
      await this.updateTrackMetadata(track.deviceId, track.trackDate, track.count);
    }
  }

  /**
   * Execute a single batch of operations
   */
  async executeBatch(operations) {
    const batch = this.db.batch();

    for (const op of operations) {
      if (op.type === 'telemetry') {
        // Create/overwrite telemetry document
        const docRef = this.db.collection(op.collection).doc(op.docId);
        batch.set(docRef, op.data);
      }
      else if (op.type === 'device') {
        // Merge device update (liveLocation)
        const docRef = this.db.collection(op.collection).doc(op.docId);
        batch.set(docRef, op.data, { merge: true });
      }
      else if (op.type === 'track_point') {
        // Create track point in subcollection
        const trackPath = `devices/${op.deviceId}/tracks/${op.trackDate}/points`;
        const docRef = this.db.collection(trackPath).doc(op.pointId);
        batch.set(docRef, op.data);
      }
    }

    console.log(`  ⏳ Committing ${operations.length} operations...`);
    await batch.commit();
    console.log(`  ✅ Committed ${operations.length} operations to Firestore`);
  }

  /**
   * Update locationHistory arrays for devices (separate from batch)
   */
  async updateLocationHistories(deviceUpdates) {
    const MAX_HISTORY_SIZE = 50;
    const BATCH_SIZE = 500;

    const updates = Array.from(deviceUpdates.entries());
    
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = this.db.batch();
      const chunk = updates.slice(i, i + BATCH_SIZE);

      for (const [deviceId, update] of chunk) {
        const deviceRef = this.db.collection('devices').doc(deviceId);
        
        // Use Firestore array union (adds if not exists, max 10 at once)
        // For simplicity, we'll do manual trimming in a separate maintenance job
        batch.update(deviceRef, {
          locationHistory: this.db.FieldValue.arrayUnion(update.locationPoint)
        });
      }

      try {
        await batch.commit();
        console.log(`  📍 Updated location history batch (${chunk.length} devices)`);
      } catch (error) {
        console.error(`  ❌ Failed to update location history batch:`, error.message);
      }
    }
  }

  /**
   * Initialize or update track metadata for a day
   */
  async updateTrackMetadata(deviceId, trackDate, pointsCount) {
    try {
      const trackMetaRef = this.db
        .collection('devices')
        .doc(deviceId)
        .collection('tracks')
        .doc(trackDate);

      const trackMeta = await trackMetaRef.get();

      if (!trackMeta.exists) {
        // Create new track metadata
        await trackMetaRef.set({
          deviceId: deviceId,
          date: trackDate,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          pointsCount: pointsCount,
          createdAt: new Date().toISOString(),
        });
        console.log(`  📊 Created track metadata for ${deviceId} on ${trackDate}`);
      } else {
        // Update existing track metadata
        await trackMetaRef.update({
          endTime: new Date().toISOString(),
          pointsCount: this.db.FieldValue.increment(pointsCount),
        });
      }
    } catch (error) {
      console.error(`  ❌ Failed to update track metadata:`, error.message);
    }
  }

  /**
   * Get collection name based on tag type
   */
  getCollectionName(tagType) {
    switch (tagType) {
      case 'tag':
        return 'telemetry_tag';
      case 'active':
        return 'telemetry_active';
      case 'sense':
        return 'telemetry_sense';
      default:
        console.warn(`Unknown tag_type: ${tagType}, defaulting to telemetry_tag`);
        return 'telemetry_tag';
    }
  }

  /**
   * Check if an unresolved alert of the same type exists for a device
   */
  async hasUnresolvedAlert(deviceId, alertIdType) {
    try {
      const alertsRef = this.db
        .collection('devices')
        .doc(deviceId)
        .collection('alerts');

      const snapshot = await alertsRef
        .where('alertIdType', '==', alertIdType)
        .where('isResolved', '==', false)
        .limit(1)
        .get();

      const exists = !snapshot.empty;

      if (exists) {
        console.log(`   ⚠️  Unresolved alert ${alertIdType} already exists for ${deviceId}`);
      }

      return exists;
    } catch (error) {
      console.error(`Error checking unresolved alerts: ${error.message}`);
      // On error, assume no alert exists (fail-open to avoid blocking)
      return false;
    }
  }

  /**
   * Create alert document in device's alerts subcollection
   */
  async createAlert(telemetry, alertTemplate) {
    const deviceId = telemetry.device_id;
    const alertId = telemetry.alert_id;

    try {
      // Create alert document
      const alertData = {
        userId: telemetry.user_id,
        alertType: alertTemplate.alertType,
        title: alertTemplate.title,
        message: alertTemplate.message,
        severity: alertTemplate.severity,
        isRead: false,
        isResolved: false,
        createdAt: new Date().toISOString(),
        readAt: null,
        resolvedAt: null,

        petId: telemetry.pet_id,
        deviceId: telemetry.device_id,
        geofenceId: telemetry.fence?.fence_id || null,

        actionUrl: null,
        priority: alertTemplate.priority,

        // Reference data
        alertIdType: alertId,
        location: {
          latitude: telemetry.location.latitude,
          longitude: telemetry.location.longitude,
          altitude: telemetry.location.altitude,
          timestamp: telemetry.location.timestamp,
        },
      };

      // Write to subcollection: devices/{device_id}/alerts/{auto_id}
      const alertRef = this.db
        .collection('devices')
        .doc(deviceId)
        .collection('alerts')
        .doc(); // Auto-generate ID

      await alertRef.set(alertData);

      console.log(`   🚨 Created alert: ${alertId} for device ${deviceId}`);
      console.log(`      Type: ${alertTemplate.alertType}, Severity: ${alertTemplate.severity}`);

      return alertRef.id;
    } catch (error) {
      console.error(`❌ Failed to create alert: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process alert if needed for telemetry
   * Returns alert ID if created, null otherwise
   */
  async processAlert(telemetry, alertTemplate) {
    const alertId = telemetry.alert_id;
    const deviceId = telemetry.device_id;

    // Check if unresolved alert already exists
    const hasUnresolved = await this.hasUnresolvedAlert(deviceId, alertId);

    if (hasUnresolved) {
      console.log(`   ⏭️  Skipping duplicate alert: ${alertId}`);
      return null;
    }

    // Create new alert
    const createdAlertId = await this.createAlert(telemetry, alertTemplate);
    return createdAlertId;
  }

  /**
   * Graceful shutdown - flush remaining batches
   */
  async shutdown() {
    console.log('\n🛑 Shutting down Firestore client...');
    clearTimeout(this.batchTimer);
    await this.flushBatches();
    console.log('✅ Firestore client shutdown complete');
  }
}
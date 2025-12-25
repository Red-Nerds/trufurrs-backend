import { Firestore, FieldValue } from '@google-cloud/firestore';
import { performanceMonitor } from '../monitoring/performance.js';

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
    
    // Track queue size
    performanceMonitor.recordQueueSize(this.telemetryQueue.length);
    
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
      console.log('📭 Queue empty, nothing to flush');
      return;
    }

    this.isProcessing = true;
    this.batchTimer = null;

    console.log(`\n⏰ BATCH TIMEOUT TRIGGERED`);

    // Declare telemetryItems outside try block so it's accessible in catch
    let telemetryItems = [];

    try {
      // Process all items in chunks of batchSize
      telemetryItems = [...this.telemetryQueue];

      // Clear queues immediately
      this.telemetryQueue = [];

      // Count unique devices for device updates
      const uniqueDevices = new Set(telemetryItems.map(t => t.device_id));
      const deviceUpdateCount = uniqueDevices.size;

      console.log(`🚀 Flushing batch: ${telemetryCount} telemetry + ${deviceUpdateCount} device updates`);

      // Combine operations and process in chunks
      await this.processBatchChunks(telemetryItems);

      console.log(`✅ Batch complete: ${telemetryCount + deviceUpdateCount} operations written to Firestore\n`);

    } catch (error) {
      console.error('❌ Batch flush error:', error);
      // Re-queue failed items
      this.telemetryQueue.push(...telemetryItems);
    } finally {
      this.isProcessing = false;

      // Restart timer if there are more items
      if (this.telemetryQueue.length > 0) {
        console.log(`🔄 Restarting timer, ${this.telemetryQueue.length} items in queue`);
        this.batchTimer = setTimeout(() => this.flushBatches(), this.batchTimeout);
      }
    }
  }

  /**
   * Process operations in chunks of batchSize
   */
  async processBatchChunks(telemetryItems) {
    const allOperations = [];

    // Prepare telemetry operations - organized by device/date/points
    for (const telemetry of telemetryItems) {
      const collection = this.getCollectionName(telemetry.tag_type);
      
      // Get date in YYYYMMDD format from telemetry timestamp
      const telemetryDate = new Date(telemetry.created_at);
      const dateString = telemetryDate.toISOString().split('T')[0].replace(/-/g, ''); // YYYYMMDD
      
      // Use timestamp from telemetry as document ID
      const telemetryTimestamp = new Date(telemetry.created_at).getTime();
      
      // Path: telemetry_active/{device_id}/dates/{date}/points/{timestamp}
      // This is 5 segments (odd number) - correct for Firestore
      allOperations.push({
        type: 'telemetry',
        collection,
        deviceId: telemetry.device_id,
        date: dateString,
        docId: telemetryTimestamp.toString(),
        data: telemetry,
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
          //heading: telemetry.compass?.heading_degrees || null,
          //direction: telemetry.compass?.direction || null,
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

    // Update telemetry metadata (points count per device per day)
    const telemetryByDeviceDate = new Map();
    for (const op of allOperations) {
      if (op.type === 'telemetry') {
        const key = `${op.deviceId}_${op.date}`;
        const existing = telemetryByDeviceDate.get(key) || {
          collection: op.collection,
          deviceId: op.deviceId,
          date: op.date,
          count: 0
        };
        existing.count++;
        telemetryByDeviceDate.set(key, existing);
      }
    }

    for (const meta of telemetryByDeviceDate.values()) {
      await this.updateTelemetryMetadata(meta.collection, meta.deviceId, meta.date, meta.count);
    }

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

    let telemetryCount = 0;
    let deviceCount = 0;
    let trackPointCount = 0;

    for (const op of operations) {
      if (op.type === 'telemetry') {
        // Create telemetry in organized structure: collection/{device_id}/dates/{date}/points/{timestamp}
        // This gives us 5 path segments (odd number) which is correct for Firestore
        const telemetryPath = `${op.collection}/${op.deviceId}/dates/${op.date}/points`;
        const docRef = this.db.collection(telemetryPath).doc(op.docId);
        batch.set(docRef, op.data);
        telemetryCount++;
      }
      else if (op.type === 'device') {
        // Merge device update (liveLocation)
        const docRef = this.db.collection(op.collection).doc(op.docId);
        batch.set(docRef, op.data, { merge: true });
        deviceCount++;
      }
      else if (op.type === 'track_point') {
        // Create track point in subcollection
        const trackPath = `devices/${op.deviceId}/tracks/${op.trackDate}/points`;
        const docRef = this.db.collection(trackPath).doc(op.pointId);
        batch.set(docRef, op.data);
        trackPointCount++;
      }
    }

    console.log(`  ⏳ Committing ${operations.length} operations...`);
    
    // Track batch commit time
    const batchTimer = performanceMonitor.startTimer('batchCommit');
    await batch.commit();
    const commitDuration = performanceMonitor.endTimer(batchTimer);
    
    // Record Firestore operations
    performanceMonitor.recordFirestoreOperation('write', telemetryCount, 'telemetryWrites');
    performanceMonitor.recordFirestoreOperation('write', deviceCount, 'deviceWrites');
    performanceMonitor.recordFirestoreOperation('write', trackPointCount, 'trackPointWrites');
    
    console.log(`  ✅ Committed ${operations.length} operations in ${commitDuration.toFixed(2)}ms`);
    console.log(`     📝 ${telemetryCount} telemetry + ${deviceCount} devices + ${trackPointCount} track points`);
    performanceMonitor.incrementCounter('totalBatches');
  }

  /**
   * Initialize or update telemetry metadata for a day
   * Path: telemetry_{type}/{device_id}/dates/{date}/metadata
   */
  async updateTelemetryMetadata(collection, deviceId, date, pointsCount) {
    const metadataTimer = performanceMonitor.startTimer('telemetryMetadataUpdate');
    
    try {
      const metaRef = this.db
        .collection(collection)
        .doc(deviceId)
        .collection('dates')
        .doc(date)
        .collection('metadata')
        .doc('stats');

      const metaDoc = await metaRef.get();
      
      // Record read operation
      performanceMonitor.recordFirestoreOperation('read', 1, 'telemetryMetadataReads');

      if (!metaDoc.exists) {
        // Create new metadata
        await metaRef.set({
          deviceId: deviceId,
          collection: collection,
          date: date,
          startTime: new Date().toISOString(),
          endTime: new Date().toISOString(),
          pointsCount: pointsCount,
          createdAt: new Date().toISOString(),
        });
        
        // Record write operation
        performanceMonitor.recordFirestoreOperation('write', 1, 'telemetryMetadataWrites');
        
        const duration = performanceMonitor.endTimer(metadataTimer);
        console.log(`  📊 Created telemetry metadata for ${deviceId} on ${date} in ${duration.toFixed(2)}ms`);
      } else {
        // Update existing metadata
        await metaRef.update({
          endTime: new Date().toISOString(),
          pointsCount: FieldValue.increment(pointsCount),
        });
        
        // Record write operation
        performanceMonitor.recordFirestoreOperation('write', 1, 'telemetryMetadataWrites');
        
        const duration = performanceMonitor.endTimer(metadataTimer);
        console.log(`  📊 Updated telemetry metadata in ${duration.toFixed(2)}ms`);
      }
    } catch (error) {
      performanceMonitor.endTimer(metadataTimer);
      console.error(`  ❌ Failed to update telemetry metadata:`, error.message);
    }
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
          locationHistory: FieldValue.arrayUnion(update.locationPoint)
        });
      }

      try {
        // Track location history update time
        const historyTimer = performanceMonitor.startTimer('locationHistoryUpdate');
        await batch.commit();
        const historyDuration = performanceMonitor.endTimer(historyTimer);
        
        // Record Firestore operations (1 write per device)
        performanceMonitor.recordFirestoreOperation('write', chunk.length, 'locationHistoryWrites');
        
        console.log(`  📍 Updated location history batch (${chunk.length} devices) in ${historyDuration.toFixed(2)}ms`);
      } catch (error) {
        console.error(`  ❌ Failed to update location history batch:`, error.message);
      }
    }
  }

  /**
   * Initialize or update track metadata for a day
   */
  async updateTrackMetadata(deviceId, trackDate, pointsCount) {
    // Track metadata update time
    const trackTimer = performanceMonitor.startTimer('trackMetadataUpdate');
    
    try {
      const trackMetaRef = this.db
        .collection('devices')
        .doc(deviceId)
        .collection('tracks')
        .doc(trackDate);

      const trackMeta = await trackMetaRef.get();
      
      // Record read operation
      performanceMonitor.recordFirestoreOperation('read', 1, 'trackMetadataReads');

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
        
        // Record write operation
        performanceMonitor.recordFirestoreOperation('write', 1, 'trackMetadataWrites');
        
        const trackDuration = performanceMonitor.endTimer(trackTimer);
        console.log(`  📊 Created track metadata for ${deviceId} on ${trackDate} in ${trackDuration.toFixed(2)}ms`);
      } else {
        // Update existing track metadata
        await trackMetaRef.update({
          endTime: new Date().toISOString(),
          pointsCount: FieldValue.increment(pointsCount),
        });
        
        // Record write operation
        performanceMonitor.recordFirestoreOperation('write', 1, 'trackMetadataWrites');
        
        const trackDuration = performanceMonitor.endTimer(trackTimer);
        console.log(`  📊 Updated track metadata in ${trackDuration.toFixed(2)}ms`);
      }
    } catch (error) {
      performanceMonitor.endTimer(trackTimer);
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

      // Record read operation (query counts as 1 read minimum)
      const readCount = Math.max(1, snapshot.size);
      performanceMonitor.recordFirestoreOperation('read', readCount, 'alertReads');

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
      
      // Record write operation
      performanceMonitor.recordFirestoreOperation('write', 1, 'alertWrites');

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
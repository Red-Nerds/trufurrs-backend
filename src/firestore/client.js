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
      return;
    }

    this.isProcessing = true;

    try {
      // Process all items in chunks of batchSize
      const telemetryItems = [...this.telemetryQueue];
      
      // Clear queues immediately
      this.telemetryQueue = [];

      // Count unique devices for device updates
      const uniqueDevices = new Set(telemetryItems.map(t => t.device_id));
      const deviceUpdateCount = uniqueDevices.size;

      console.log(`\n🚀 Flushing batch: ${telemetryCount} telemetry + ${deviceUpdateCount} device updates`);

      // Combine operations and process in chunks
      await this.processBatchChunks(telemetryItems);

      console.log(`✅ Batch complete: ${telemetryCount + deviceUpdateCount} operations written to Firestore`);
    } catch (error) {
      console.error('❌ Batch flush error:', error);
      // Re-queue failed items
      this.telemetryQueue.push(...this.telemetryQueue);
    } finally {
      this.isProcessing = false;
      
      // Restart timer if there are more items
      if (this.telemetryQueue.length > 0) {
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
    for (const telemetry of telemetryItems) {
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
          }
        }
      });
    }

    allOperations.push(...deviceUpdates.values());

    // Process in chunks of batchSize
    for (let i = 0; i < allOperations.length; i += this.batchSize) {
      const chunk = allOperations.slice(i, i + this.batchSize);
      await this.executeBatch(chunk);
    }
  }

  /**
   * Execute a single batch of operations
   */
  async executeBatch(operations) {
    const batch = this.db.batch();
    
    for (const op of operations) {
      const docRef = this.db.collection(op.collection).doc(op.docId);
      
      if (op.type === 'telemetry') {
        // Create/overwrite telemetry document
        batch.set(docRef, op.data);
      } else if (op.type === 'device') {
        // Merge device update (no read required!)
        batch.set(docRef, op.data, { merge: true });
      }
    }

    await batch.commit();
    console.log(`  ✓ Committed batch: ${operations.length} operations`);
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
   * Graceful shutdown - flush remaining batches
   */
  async shutdown() {
    console.log('\n🛑 Shutting down Firestore client...');
    clearTimeout(this.batchTimer);
    await this.flushBatches();
    console.log('✅ Firestore client shutdown complete');
  }
}
import dotenv from 'dotenv';
import { MqttClient } from './mqtt/client.js';
import { FirestoreClient } from './firestore/client.js';
import { MessageProcessor } from './processor/handler.js';
import { performanceMonitor } from './monitoring/performance.js';

// Load environment variables
dotenv.config();

// Configuration
const config = {
  mqtt: {
    broker: process.env.MQTT_BROKER || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    topic: process.env.MQTT_TOPIC || 'trufurrs/#',
  },
  firestore: {
    projectId: process.env.FIRESTORE_PROJECT_ID,
    batchSize: parseInt(process.env.BATCH_SIZE || '500'),
    batchTimeout: parseInt(process.env.BATCH_TIMEOUT_MS || '3000'),
  },
};

// Validate configuration
function validateConfig() {
  if (!config.mqtt.username || !config.mqtt.password) {
    throw new Error('MQTT_USERNAME and MQTT_PASSWORD must be set in .env');
  }
  if (!config.firestore.projectId) {
    throw new Error('FIRESTORE_PROJECT_ID must be set in .env');
  }
}

async function main() {
  console.log('🚀 Starting Trufurrs Backend (Node.js)...\n');

  try {
    // Validate config
    validateConfig();

    // Initialize clients
    const mqttClient = new MqttClient(
      config.mqtt.broker,
      config.mqtt.username,
      config.mqtt.password
    );

    const firestoreClient = new FirestoreClient(
      config.firestore.projectId,
      config.firestore.batchSize,
      config.firestore.batchTimeout
    );

    const processor = new MessageProcessor();

    // Connect to MQTT
    await mqttClient.connect();
    await mqttClient.subscribe(config.mqtt.topic);

    console.log('\n✅ All systems ready!');
    console.log('⏳ Waiting for messages...\n');

    // Message counter for stats
    let messageCount = 0;
    let errorCount = 0;

    // Handle incoming messages
    mqttClient.onMessage(async (topic, payload) => {
      // START: Track overall message processing time
      const messageTimer = performanceMonitor.startTimer('messageProcessing');
      
      try {
        messageCount++;
        performanceMonitor.incrementCounter('totalMessages');

        // Handle test/topic differently - just log
        if (topic === 'test/topic') {
          const payloadStr = payload.toString('utf8');
          console.log(`🧪 Test message received: ${payloadStr}`);
          performanceMonitor.incrementCounter('successfulMessages');
          performanceMonitor.endTimer(messageTimer);
          return;
        }

        // Process message
        const telemetry = processor.processMessage(topic, payload);

        console.log(`✅ Processed telemetry for device: ${telemetry.device_id}`);
        console.log(`   Tag Type: ${telemetry.tag_type}`);
        console.log(`   Location: lat=${telemetry.location.latitude}, lon=${telemetry.location.longitude}, alt=${telemetry.location.altitude}`);
        console.log(`   Battery: ${telemetry.device.battery_level}%`);
        console.log(`   GPS Signal: ${telemetry.location.GPS_signal}`);

        // Check for alerts
        const alertTemplate = processor.getAlertTemplate(telemetry);
        if (alertTemplate) {
          console.log(`   🔔 Alert detected: ${telemetry.alert_id}`);
          
          // Track alert processing time
          const alertTimer = performanceMonitor.startTimer('alertProcessing');
          try {
            const alertCreated = await firestoreClient.processAlert(telemetry, alertTemplate);
            
            if (alertCreated) {
              performanceMonitor.incrementCounter('totalAlerts');
            } else {
              performanceMonitor.incrementCounter('skippedAlerts');
            }
            
            const alertDuration = performanceMonitor.endTimer(alertTimer);
            console.log(`   ⏱️  Alert processing took: ${alertDuration.toFixed(2)}ms`);
          } catch (error) {
            performanceMonitor.endTimer(alertTimer);
            console.error(`   ❌ Alert processing failed: ${error.message}`);
            // Continue with telemetry processing even if alert fails
          }
        }

        // Queue for batch processing (track queue size)
        await firestoreClient.queueTelemetry(telemetry);
        
        // Record successful processing
        performanceMonitor.incrementCounter('successfulMessages');

        // END: Track message processing time
        const processingDuration = performanceMonitor.endTimer(messageTimer);
        console.log(`⏱️  Total processing time: ${processingDuration.toFixed(2)}ms`);

        // Log stats every 100 messages
        if (messageCount % 100 === 0) {
          performanceMonitor.printReport();
        }

      } catch (error) {
        errorCount++;
        performanceMonitor.incrementCounter('failedMessages');
        performanceMonitor.endTimer(messageTimer);
        console.error(`❌ Failed to process message from ${topic}:`, error.message);
      }
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n\n🛑 Shutting down gracefully...');
      
      await mqttClient.disconnect();
      await firestoreClient.shutdown();
      
      // Print final performance report
      console.log('\n📊 FINAL PERFORMANCE REPORT:');
      performanceMonitor.printReport();
      
      // Print historical daily operations
      performanceMonitor.printDailyHistory();
      
      console.log('\n👋 Goodbye!\n');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Start the application
main();
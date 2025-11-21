import dotenv from 'dotenv';
import { MqttClient } from './mqtt/client.js';
import { FirestoreClient } from './firestore/client.js';
import { MessageProcessor } from './processor/handler.js';

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
    const startTime = Date.now();

    // Handle incoming messages
    mqttClient.onMessage(async (topic, payload) => {
      try {
        messageCount++;

        // Handle test/topic differently - just log
        if (topic === 'test/topic') {
          const payloadStr = payload.toString('utf8');
          console.log(`🧪 Test message received: ${payloadStr}`);
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
          try {
            await firestoreClient.processAlert(telemetry, alertTemplate);
          } catch (error) {
            console.error(`   ❌ Alert processing failed: ${error.message}`);
            // Continue with telemetry processing even if alert fails
          }
        }

        // Queue for batch processing
        await firestoreClient.queueTelemetry(telemetry);

        // Log stats every 100 messages
        if (messageCount % 100 === 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = (messageCount / elapsed).toFixed(2);
          console.log(`\n📊 Stats: ${messageCount} messages processed (${rate} msg/sec), ${errorCount} errors\n`);
        }

      } catch (error) {
        errorCount++;
        console.error(`❌ Failed to process message from ${topic}:`, error.message);
      }
    });

    // Graceful shutdown
    const shutdown = async () => {
      console.log('\n\n🛑 Shutting down gracefully...');
      
      await mqttClient.disconnect();
      await firestoreClient.shutdown();
      
      const elapsed = (Date.now() - startTime) / 1000;
      console.log(`\n📊 Final Stats:`);
      console.log(`   Total messages: ${messageCount}`);
      console.log(`   Errors: ${errorCount}`);
      console.log(`   Runtime: ${elapsed.toFixed(2)}s`);
      console.log(`   Average rate: ${(messageCount / elapsed).toFixed(2)} msg/sec`);
      
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
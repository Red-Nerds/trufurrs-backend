import mqtt from 'mqtt';

export class MqttClient {
  constructor(brokerUrl, username, password, clientId = null) {
    const uniqueClientId = clientId || `trufurrs-backend-${Date.now()}`;
    this.brokerUrl = brokerUrl;
    this.options = {
      clientId: uniqueClientId,
      username,
      password,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      keepAlive: 60,
    };

    this.client = null;
    this.messageHandler = null;
  }

  /**
   * Connect to MQTT broker
   */
  async connect() {
    return new Promise((resolve, reject) => {
      console.log(`🔌 Connecting to MQTT broker: ${this.brokerUrl}`);

      this.client = mqtt.connect(this.brokerUrl, this.options);

      this.client.on('connect', () => {
        console.log('✅ Connected to MQTT broker');
        resolve();
      });

      this.client.on('error', (error) => {
        console.error('❌ MQTT connection error:', error);
        reject(error);
      });

      this.client.on('reconnect', () => {
        console.log('🔄 Reconnecting to MQTT broker...');
      });

      this.client.on('offline', () => {
        console.log('📡 MQTT client offline');
      });

      this.client.on('message', (topic, payload) => {
        if (this.messageHandler) {
          // DEBUG: Log raw payload info
          console.log('🔍 MQTT RAW MESSAGE:');
          console.log('   Topic:', topic);
          console.log('   Payload length:', payload.length);
          console.log('   Payload type:', typeof payload);
          console.log('   Payload buffer:', payload);
          console.log('   Payload string:', payload.toString('utf8'));
          console.log('   Last 20 bytes:', payload.slice(-20));

          this.messageHandler(topic, payload);
        }
      });
    });
  }

  /**
   * Subscribe to MQTT topic
   */
  async subscribe(topic) {
    return new Promise((resolve, reject) => {
      this.client.subscribe(topic, { qos: 0 }, (error) => {
        if (error) {
          console.error(`❌ Failed to subscribe to ${topic}:`, error);
          reject(error);
        } else {
          console.log(`📬 Subscribed to topic: ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * Set message handler callback
   */
  onMessage(handler) {
    this.messageHandler = handler;
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect() {
    return new Promise((resolve) => {
      if (this.client) {
        console.log('🔌 Disconnecting from MQTT broker...');
        this.client.end(false, () => {
          console.log('✅ Disconnected from MQTT broker');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
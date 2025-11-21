import { getAlertTemplate, isRealtimeAlert } from '../alerts/templates.js';

export class MessageProcessor {
  constructor() {}

  /**
   * Process incoming MQTT message
   */
  processMessage(topic, payload) {
    console.log(`📩 Processing message from: ${topic}`);

    // Extract tag_type from topic: trufurrs/{tag_type}/telemetry
    const tagType = this.extractTagType(topic);
    console.log(`   Tag type: ${tagType}`);

    // Convert payload to string
    const payloadStr = payload.toString('utf8');
    
    // Parse JSON
    let jsonData;
    try {
      jsonData = JSON.parse(payloadStr);
    } catch (error) {
      throw new Error(`Failed to parse JSON: ${error.message}`);
    }

    // Validate required fields
    this.validateTelemetry(jsonData);

    // Create telemetry data object
    const telemetry = {
      device_id: jsonData.device_id,
      tag_type: tagType,
      firmware_version: jsonData.firmware_version,
      pet_id: jsonData.pet_id,
      user_id: jsonData.user_id,
      alert_id: jsonData.alert_id,
      location: {
        GPS_signal: jsonData.location.GPS_signal,
        longitude: jsonData.location.longitude,
        latitude: jsonData.location.latitude,
        altitude: jsonData.location.altitude,
        timestamp: jsonData.location.timestamp,
      },
      activity: {
        acc_x: jsonData.activity.acc_x,
        acc_y: jsonData.activity.acc_y,
        acc_z: jsonData.activity.acc_z,
        gyro_x: jsonData.activity.gyro_x,
        gyro_y: jsonData.activity.gyro_y,
        gyro_z: jsonData.activity.gyro_z,
        temperature: jsonData.activity.temperature,
      },
      compass: {
        heading_degrees: jsonData.compass.heading_degrees,
        direction: jsonData.compass.direction,
      },
      device: {
        battery_level: jsonData.device.battery_level,
        heartbeat: jsonData.device.heartbeat,
      },
      fence: {
        fence_id: jsonData.fence.fence_id,
        status: jsonData.fence.status,
        center_lat: jsonData.fence.center_lat,
        center_lon: jsonData.fence.center_lon,
        radius_m: jsonData.fence.radius_m,
        distance_m: jsonData.fence.distance_m,
      },
      created_at: new Date().toISOString(),
    };

    // Set processed_at to null for active/sense, omit for tag
    if (tagType !== 'tag') {
      telemetry.processed_at = null;
    }

    return telemetry;
  }

  /**
   * Extract tag type from MQTT topic
   */
  extractTagType(topic) {
    // Expected format: trufurrs/{tag_type}/telemetry
    const parts = topic.split('/');

    if (parts.length >= 2 && parts[0] === 'trufurrs') {
      const tagType = parts[1];
      if (['tag', 'active', 'sense'].includes(tagType)) {
        return tagType;
      }
      throw new Error(`Invalid tag_type in topic: ${tagType}`);
    }

    throw new Error(`Invalid topic format: ${topic}`);
  }

  /**
   * Validate telemetry data structure
   */
  validateTelemetry(data) {
    const required = [
      'device_id',
      'firmware_version',
      'pet_id',
      'user_id',
      'location',
      'activity',
      'compass',
      'device',
      'fence',
    ];

    // Fields that can be empty strings
    const optionalStringFields = ['alert_id'];

    for (const field of required) {
      if (data[field] === undefined || data[field] === null) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Check optional fields exist (can be empty strings)
    for (const field of optionalStringFields) {
      if (data[field] === undefined || data[field] === null) {
        throw new Error(`Missing required field: ${field}`);
      }
    }

    // Validate nested location fields
    const locationFields = ['GPS_signal', 'longitude', 'latitude', 'altitude', 'timestamp'];
    for (const field of locationFields) {
      if (data.location[field] === undefined) {
        throw new Error(`Missing location field: ${field}`);
      }
    }

    // Validate nested compass fields
    const compassFields = ['heading_degrees', 'direction'];
    for (const field of compassFields) {
      if (data.compass[field] === undefined) {
        throw new Error(`Missing compass field: ${field}`);
      }
    }

    return true;
  }

  /**
   * Get alert template if alert_id is present and valid
   */
  getAlertTemplate(telemetry) {
    const alertId = telemetry.alert_id;

    // Skip if no alert_id or empty
    if (!alertId || alertId === '') {
      return null;
    }

    // Check if it's a real-time alert (Phase 1)
    if (!isRealtimeAlert(alertId)) {
      console.log(`   ⏭️  Skipping non-realtime alert: ${alertId} (will be processed by worker)`);
      return null;
    }

    // Get template
    const template = getAlertTemplate(alertId, telemetry);
    
    if (!template) {
      console.warn(`   ⚠️  Unknown alert_id: ${alertId}`);
      return null;
    }

    return template;
  }
}
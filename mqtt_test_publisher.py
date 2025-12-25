#!/usr/bin/env python3
"""
MQTT Test Publisher for TruFurrs Backend
Publishes telemetry messages at 1-minute intervals with slight location variations
"""

import json
import time
import random
from datetime import datetime
import paho.mqtt.client as mqtt

# ============================================================================
# CONFIGURATION - Modify these values
# ============================================================================

# MQTT Broker Configuration
MQTT_HOST = "mqtt.therednerds.com"
MQTT_PORT = 1883
MQTT_USERNAME = "pettracker"
MQTT_PASSWORD = "Trufurrs123"
MQTT_TOPIC = "trufurrs/active/telemetry"

# Test Configuration
DEVICE_ID = "e9774B0cbF604C1d8A82"
PET_ID = "CAE1530A53FA43D297BB"
USER_ID = "4No48hqwn9OhfAJ6PyFuJVWo9Az1"
DURATION_MINUTES = 150  # How long to run the test (in minutes)

# Base Location (will vary slightly with each message)
BASE_LATITUDE = 12.860855
BASE_LONGITUDE = 77.659462
BASE_ALTITUDE = 864.14

# Variation ranges (how much to vary location per message)
LAT_VARIATION = 0.0001  # ~11 meters
LON_VARIATION = 0.0001  # ~11 meters
ALT_VARIATION = 2.0     # meters

# Alert ID options (randomly selected or set to "" for no alert)
ALERT_IDS = [
    "",  # No alert (most common)
    "",
    "",
    "",
    "ALR-BAT-001",  # Battery low
    "ALT-LOC-001",  # Out of zone
]

# ============================================================================
# Helper Functions
# ============================================================================

def get_current_timestamp():
    """Get current timestamp in ISO format"""
    return datetime.now().isoformat()

def vary_location(base_lat, base_lon, base_alt):
    """Add small random variation to location"""
    lat = base_lat + random.uniform(-LAT_VARIATION, LAT_VARIATION)
    lon = base_lon + random.uniform(-LON_VARIATION, LON_VARIATION)
    alt = base_alt + random.uniform(-ALT_VARIATION, ALT_VARIATION)
    return round(lat, 6), round(lon, 6), round(alt, 2)

def calculate_distance(lat1, lon1, lat2, lon2):
    """Calculate approximate distance in meters between two points"""
    # Simplified calculation (works for small distances)
    lat_diff = abs(lat1 - lat2) * 111000  # 1 degree lat ≈ 111km
    lon_diff = abs(lon1 - lon2) * 111000 * 0.88  # Adjusted for latitude
    return round((lat_diff**2 + lon_diff**2)**0.5, 2)

def generate_telemetry_message(lat, lon, alt):
    """Generate a complete telemetry message"""
    
    # Get current timestamp
    timestamp = get_current_timestamp()
    
    # Random battery level
    battery = round(random.uniform(15.0, 100.0), 2)
    step_count = random.randint(0, 5000)
    
    # Fence data (centered on base location)
    fence_center_lat = 12.860779
    fence_center_lon = 77.659538
    fence_radius = 20.0
    distance_from_fence = calculate_distance(lat, lon, fence_center_lat, fence_center_lon)
    fence_status = "inside_fence" if distance_from_fence < fence_radius else "outside_fence"
    
    # Select alert ID (mostly empty, occasionally an alert)
    alert_id = random.choice(ALERT_IDS)
    
    message = {
        "device_id": DEVICE_ID,
        "firmware_version": "Tag-Active",
        "pet_id": PET_ID,
        "user_id": USER_ID,
        "alert_id": alert_id,
        "location": {
            "GPS_signal": "Available",
            "longitude": lon,
            "latitude": lat,
            "altitude": alt,
            "timestamp": timestamp
        },
        "device": {
            "battery_level": battery,
            "step_count": step_count,
            "heartbeat": 2
        },
        "fence": {
            "fence_id": "FENCE001",
            "status": fence_status,
            "center_lat": fence_center_lat,
            "center_lon": fence_center_lon,
            "radius_m": fence_radius,
            "distance_m": distance_from_fence
        }
    }
    
    return message

# ============================================================================
# MQTT Functions
# ============================================================================

def on_connect(client, userdata, flags, rc):
    """Callback when connected to MQTT broker"""
    if rc == 0:
        print(f"✅ Connected to MQTT broker: {MQTT_HOST}:{MQTT_PORT}")
    else:
        print(f"❌ Connection failed with code {rc}")

def on_publish(client, userdata, mid):
    """Callback when message is published"""
    print(f"📤 Message {userdata['count']} published (MID: {mid})")

def on_disconnect(client, userdata, rc):
    """Callback when disconnected from MQTT broker"""
    if rc != 0:
        print(f"⚠️  Unexpected disconnection (code: {rc})")

# ============================================================================
# Main Test Function
# ============================================================================

def run_test():
    """Run the MQTT publishing test"""
    
    print("=" * 80)
    print("🚀 TruFurrs MQTT Test Publisher")
    print("=" * 80)
    print(f"📡 Broker:        {MQTT_HOST}:{MQTT_PORT}")
    print(f"📌 Topic:         {MQTT_TOPIC}")
    print(f"🆔 Device ID:     {DEVICE_ID}")
    print(f"⏱️  Duration:      {DURATION_MINUTES} minutes")
    print(f"📍 Base Location: {BASE_LATITUDE}, {BASE_LONGITUDE}")
    print(f"🔄 Interval:      60 seconds")
    print("=" * 80)
    
    # Setup MQTT client
    client = mqtt.Client()
    client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
    
    # Setup userdata for counting messages
    client.user_data_set({"count": 0})
    
    # Setup callbacks
    client.on_connect = on_connect
    client.on_publish = on_publish
    client.on_disconnect = on_disconnect
    
    # Connect to broker
    try:
        print(f"\n🔌 Connecting to {MQTT_HOST}...")
        client.connect(MQTT_HOST, MQTT_PORT, 60)
        client.loop_start()
        time.sleep(2)  # Wait for connection
        
    except Exception as e:
        print(f"❌ Failed to connect: {e}")
        return
    
    # Calculate number of messages
    total_messages = DURATION_MINUTES
    
    print(f"\n📨 Starting to publish {total_messages} messages...\n")
    
    # Publish messages
    for i in range(total_messages):
        try:
            # Generate varied location
            lat, lon, alt = vary_location(BASE_LATITUDE, BASE_LONGITUDE, BASE_ALTITUDE)
            
            # Generate message
            message = generate_telemetry_message(lat, lon, alt)
            
            # Convert to JSON
            message_json = json.dumps(message)

            # DEBUG: Log what we're sending
            print(f"\n🔍 PYTHON SENDING:")
            print(f"   Payload length: {len(message_json)}")
            print(f"   Payload type: {type(message_json)}")
            print(f"   First 100 chars: {message_json[:100]}")
            print(f"   Last 100 chars: {message_json[-100:]}")
            print(f"   Full payload: {message_json}")

            
            # Publish
            result = client.publish(MQTT_TOPIC, message_json, qos=2)
            
            # Update count
            client._userdata["count"] = i + 1
            
            # Log details
            print(f"\n📍 Message {i+1}/{total_messages}")
            print(f"   Location: {lat}, {lon}, {alt}m")
            print(f"   Battery:  {message['device']['battery_level']}%")
            print(f"   Steps:    {message['device']['step_count']}")
            print(f"   Fence:    {message['fence']['status']} ({message['fence']['distance_m']}m)")
            if message['alert_id']:
                print(f"   🚨 Alert: {message['alert_id']}")
            print(f"   Time:     {message['location']['timestamp']}")
            
            # Wait 60 seconds before next message (except for last message)
            if i < total_messages - 1:
                print(f"\n⏳ Waiting 60 seconds...")
                time.sleep(60)
            
        except KeyboardInterrupt:
            print("\n\n⚠️  Test interrupted by user")
            break
        except Exception as e:
            print(f"❌ Error publishing message {i+1}: {e}")
            continue
    
    # Cleanup
    print(f"\n\n✅ Test completed! Published {client._userdata['count']} messages")
    print("🔌 Disconnecting...")
    client.loop_stop()
    client.disconnect()
    print("👋 Done!\n")

# ============================================================================
# Entry Point
# ============================================================================

if __name__ == "__main__":
    try:
        run_test()
    except KeyboardInterrupt:
        print("\n\n👋 Test stopped by user\n")
    except Exception as e:
        print(f"\n❌ Fatal error: {e}\n")
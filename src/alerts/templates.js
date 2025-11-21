export const ALERT_TEMPLATES = {
  // Location Alerts
  'ALT-LOC-001': {
    alertType: 'geofence',
    title: 'Out-of-Zone Alert',
    message: 'Device has exited the geofence {fence_id}',
    severity: 'high',
    priority: 'high',
  },
  'ALT-LOC-002': {
    alertType: 'geofence',
    title: 'Re-Entry Notification',
    message: 'Device has re-entered the geofence {fence_id}',
    severity: 'medium',
    priority: 'normal',
  },
  'ALT-LOC-003': {
    alertType: 'geofence',
    title: 'Auto-SOS on Fast Escape',
    message: 'Device may be in distress - fast exit detected from {fence_id}',
    severity: 'critical',
    priority: 'high',
  },
  'ALT-LOC-004': {
    alertType: 'geofence',
    title: 'Low GPS Confidence',
    message: 'GPS accuracy is unstable. Attempting to re-establish accurate tracking',
    severity: 'high',
    priority: 'high',
  },
  'ALT-LOC-005': {
    alertType: 'lostConnection',
    title: 'No GPS Signal',
    message: 'GPS signal lost. Showing approximate location',
    severity: 'medium',
    priority: 'normal',
  },
  'ALT-LOC-006': {
    alertType: 'deviceOffline',
    title: 'Device Not Connected',
    message: 'Unable to track device. GPS and connectivity lost',
    severity: 'critical',
    priority: 'high',
  },

  // Battery Alerts
  'ALR-BAT-001': {
    alertType: 'lowBattery',
    title: 'Battery Low',
    message: 'Device battery is below 20%',
    severity: 'high',
    priority: 'high',
  },
  'ALR-BAT-002': {
    alertType: 'lowBattery',
    title: 'Battery Critical',
    message: 'Device battery is critically low (below 10%). Health monitoring paused',
    severity: 'critical',
    priority: 'high',
  },
  'ALR-BAT-003': {
    alertType: 'lowBattery',
    title: 'Charging Complete',
    message: 'Device battery is fully charged',
    severity: 'low',
    priority: 'low',
  },
};

/**
 * Get alert template with interpolated values
 */
export function getAlertTemplate(alertId, telemetry) {
  const template = ALERT_TEMPLATES[alertId];
  
  if (!template) {
    return null;
  }

  // Clone template
  const alert = { ...template };

  // Interpolate fence_id in message if present
  if (alert.message.includes('{fence_id}') && telemetry.fence?.fence_id) {
    alert.message = alert.message.replace('{fence_id}', telemetry.fence.fence_id);
  }

  return alert;
}

/**
 * Check if alert_id is valid for real-time processing
 */
export function isRealtimeAlert(alertId) {
  if (!alertId || alertId === '') {
    return false;
  }
  
  // Only location and battery alerts in Phase 1
  return alertId.startsWith('ALT-LOC-') || alertId.startsWith('ALR-BAT-');
}
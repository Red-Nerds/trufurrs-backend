/**
 * Performance monitoring service for tracking operation timings
 */
export class PerformanceMonitor {
  constructor() {
    this.metrics = {
      messageProcessing: [],
      batchCommit: [],
      alertProcessing: [],
      queueWaitTime: [],
      locationHistoryUpdate: [],
      trackMetadataUpdate: [],
    };

    this.counters = {
      totalMessages: 0,
      successfulMessages: 0,
      failedMessages: 0,
      totalBatches: 0,
      totalAlerts: 0,
      skippedAlerts: 0,
    };

    this.startTime = Date.now();
    this.lastStatsTime = Date.now();
    this.lastStatsCount = 0;

    // Queue size tracking
    this.queueSizes = [];

    // Daily Firestore operations tracking
    this.dailyOperations = {
      date: this.getCurrentDate(),
      reads: 0,
      writes: 0,
      deletes: 0,
      breakdown: {
        telemetryWrites: 0,
        deviceWrites: 0,
        trackPointWrites: 0,
        locationHistoryWrites: 0,
        trackMetadataReads: 0,
        trackMetadataWrites: 0,
        telemetryMetadataReads: 0,
        telemetryMetadataWrites: 0,
        alertReads: 0,
        alertWrites: 0,
      },
      estimatedCost: 0, // USD
    };

    // Historical daily reports (keep last 30 days)
    this.dailyReports = [];
  }

  /**
   * Get current date in YYYY-MM-DD format
   */
  getCurrentDate() {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * Check if we need to roll over to a new day
   */
  checkDayRollover() {
    const currentDate = this.getCurrentDate();
    
    if (currentDate !== this.dailyOperations.date) {
      // Save yesterday's report
      this.dailyReports.push({ ...this.dailyOperations });
      
      // Keep only last 30 days
      if (this.dailyReports.length > 30) {
        this.dailyReports.shift();
      }

      // Reset for new day
      this.dailyOperations = {
        date: currentDate,
        reads: 0,
        writes: 0,
        deletes: 0,
        breakdown: {
          telemetryWrites: 0,
          deviceWrites: 0,
          trackPointWrites: 0,
          locationHistoryWrites: 0,
          trackMetadataReads: 0,
          trackMetadataWrites: 0,
          telemetryMetadataReads: 0,
          telemetryMetadataWrites: 0,
          alertReads: 0,
          alertWrites: 0,
        },
        estimatedCost: 0,
      };

      console.log(`\n📅 Day rollover detected. Starting new tracking for ${currentDate}`);
    }
  }

  /**
   * Record Firestore operations
   * @param {string} operationType - 'read', 'write', or 'delete'
   * @param {number} count - Number of operations
   * @param {string} category - Specific breakdown category (optional)
   */
  recordFirestoreOperation(operationType, count = 1, category = null) {
    this.checkDayRollover();

    // Update main counters
    if (operationType === 'read') {
      this.dailyOperations.reads += count;
    } else if (operationType === 'write') {
      this.dailyOperations.writes += count;
    } else if (operationType === 'delete') {
      this.dailyOperations.deletes += count;
    }

    // Update breakdown if category provided
    if (category && this.dailyOperations.breakdown[category] !== undefined) {
      this.dailyOperations.breakdown[category] += count;
    }

    // Calculate estimated cost
    this.updateEstimatedCost();
  }

  /**
   * Calculate estimated Firestore cost based on operations
   * Pricing: https://firebase.google.com/docs/firestore/quotas
   * - Reads: $0.06 per 100K operations
   * - Writes: $0.18 per 100K operations
   * - Deletes: $0.02 per 100K operations
   */
  updateEstimatedCost() {
    const readCost = (this.dailyOperations.reads / 100000) * 0.06;
    const writeCost = (this.dailyOperations.writes / 100000) * 0.18;
    const deleteCost = (this.dailyOperations.deletes / 100000) * 0.02;
    
    this.dailyOperations.estimatedCost = readCost + writeCost + deleteCost;
  }

  /**
   * Start timing an operation
   */
  startTimer(operationName) {
    return {
      operationName,
      startTime: process.hrtime.bigint(),
    };
  }

  /**
   * End timing and record metric
   */
  endTimer(timer) {
    const endTime = process.hrtime.bigint();
    const durationMs = Number(endTime - timer.startTime) / 1_000_000; // Convert to ms

    if (this.metrics[timer.operationName]) {
      this.metrics[timer.operationName].push(durationMs);
      
      // Keep only last 1000 measurements to prevent memory issues
      if (this.metrics[timer.operationName].length > 1000) {
        this.metrics[timer.operationName].shift();
      }
    }

    return durationMs;
  }

  /**
   * Record queue size
   */
  recordQueueSize(size) {
    this.queueSizes.push(size);
    
    // Keep only last 1000 measurements
    if (this.queueSizes.length > 1000) {
      this.queueSizes.shift();
    }
  }

  /**
   * Increment counter
   */
  incrementCounter(counterName, value = 1) {
    if (this.counters[counterName] !== undefined) {
      this.counters[counterName] += value;
    }
  }

  /**
   * Calculate statistics for a metric array
   */
  calculateStats(metricArray) {
    if (metricArray.length === 0) {
      return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0, count: 0 };
    }

    const sorted = [...metricArray].sort((a, b) => a - b);
    const count = sorted.length;

    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / count;

    const p50Index = Math.floor(count * 0.5);
    const p95Index = Math.floor(count * 0.95);
    const p99Index = Math.floor(count * 0.99);

    return {
      min: sorted[0].toFixed(2),
      max: sorted[count - 1].toFixed(2),
      avg: avg.toFixed(2),
      p50: sorted[p50Index].toFixed(2),
      p95: sorted[p95Index].toFixed(2),
      p99: sorted[p99Index].toFixed(2),
      count,
    };
  }

  /**
   * Get current performance report
   */
  getReport() {
    const now = Date.now();
    const totalElapsed = (now - this.startTime) / 1000;
    const intervalElapsed = (now - this.lastStatsTime) / 1000;
    
    const messagesInInterval = this.counters.totalMessages - this.lastStatsCount;
    const currentRate = intervalElapsed > 0 ? (messagesInInterval / intervalElapsed).toFixed(2) : 0;
    const overallRate = totalElapsed > 0 ? (this.counters.totalMessages / totalElapsed).toFixed(2) : 0;

    const report = {
      summary: {
        totalMessages: this.counters.totalMessages,
        successfulMessages: this.counters.successfulMessages,
        failedMessages: this.counters.failedMessages,
        totalBatches: this.counters.totalBatches,
        totalAlerts: this.counters.totalAlerts,
        skippedAlerts: this.counters.skippedAlerts,
        uptimeSeconds: totalElapsed.toFixed(2),
        currentRate: `${currentRate} msg/sec`,
        overallRate: `${overallRate} msg/sec`,
      },
      timings: {},
      queue: {
        current: this.queueSizes[this.queueSizes.length - 1] || 0,
        ...this.calculateStats(this.queueSizes),
      },
    };

    // Calculate stats for each metric
    for (const [metricName, metricArray] of Object.entries(this.metrics)) {
      if (metricArray.length > 0) {
        report.timings[metricName] = this.calculateStats(metricArray);
      }
    }

    // Update last stats tracking
    this.lastStatsTime = now;
    this.lastStatsCount = this.counters.totalMessages;

    return report;
  }

  /**
   * Print formatted performance report
   */
  printReport() {
    const report = this.getReport();

    console.log('\n' + '='.repeat(80));
    console.log('📊 PERFORMANCE REPORT');
    console.log('='.repeat(80));

    // Summary
    console.log('\n📈 SUMMARY:');
    console.log(`   Total Messages:     ${report.summary.totalMessages}`);
    console.log(`   ✅ Successful:      ${report.summary.successfulMessages}`);
    console.log(`   ❌ Failed:          ${report.summary.failedMessages}`);
    console.log(`   📦 Total Batches:   ${report.summary.totalBatches}`);
    console.log(`   🚨 Alerts Created:  ${report.summary.totalAlerts}`);
    console.log(`   ⏭️  Alerts Skipped:  ${report.summary.skippedAlerts}`);
    console.log(`   ⏱️  Uptime:          ${report.summary.uptimeSeconds}s`);
    console.log(`   🔥 Current Rate:    ${report.summary.currentRate}`);
    console.log(`   📊 Overall Rate:    ${report.summary.overallRate}`);

    // Daily Firestore operations
    this.printDailyOperations();

    // Queue stats
    console.log('\n📦 QUEUE STATS:');
    console.log(`   Current Size:       ${report.queue.current}`);
    console.log(`   Avg Size:           ${report.queue.avg}`);
    console.log(`   Max Size:           ${report.queue.max}`);
    console.log(`   P95 Size:           ${report.queue.p95}`);

    // Timing breakdown
    console.log('\n⏱️  TIMING BREAKDOWN (ms):');
    console.log('   ' + '-'.repeat(76));
    console.log('   Operation                    | Avg    | P50    | P95    | P99    | Count');
    console.log('   ' + '-'.repeat(76));

    const timingLabels = {
      messageProcessing: 'Message Processing',
      batchCommit: 'Batch Commit',
      alertProcessing: 'Alert Processing',
      queueWaitTime: 'Queue Wait Time',
      locationHistoryUpdate: 'Location History Update',
      trackMetadataUpdate: 'Track Metadata Update',
    };

    for (const [metric, label] of Object.entries(timingLabels)) {
      if (report.timings[metric]) {
        const stats = report.timings[metric];
        const paddedLabel = label.padEnd(28);
        console.log(
          `   ${paddedLabel} | ${String(stats.avg).padStart(6)} | ${String(stats.p50).padStart(6)} | ${String(stats.p95).padStart(6)} | ${String(stats.p99).padStart(6)} | ${stats.count}`
        );
      }
    }

    console.log('   ' + '-'.repeat(76));
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Print daily Firestore operations report
   */
  printDailyOperations() {
    this.checkDayRollover();

    console.log('\n💰 FIRESTORE OPERATIONS (Today):');
    console.log(`   Date:               ${this.dailyOperations.date}`);
    console.log(`   📖 Total Reads:     ${this.dailyOperations.reads.toLocaleString()}`);
    console.log(`   ✍️  Total Writes:    ${this.dailyOperations.writes.toLocaleString()}`);
    console.log(`   🗑️  Total Deletes:   ${this.dailyOperations.deletes.toLocaleString()}`);
    console.log(`   💵 Estimated Cost:  $${this.dailyOperations.estimatedCost.toFixed(4)}`);

    console.log('\n   📊 Breakdown:');
    console.log(`      Telemetry Writes:        ${this.dailyOperations.breakdown.telemetryWrites.toLocaleString()}`);
    console.log(`      Device Updates:          ${this.dailyOperations.breakdown.deviceWrites.toLocaleString()}`);
    console.log(`      Track Points:            ${this.dailyOperations.breakdown.trackPointWrites.toLocaleString()}`);
    console.log(`      Location History:        ${this.dailyOperations.breakdown.locationHistoryWrites.toLocaleString()}`);
    console.log(`      Track Metadata (R/W):    ${this.dailyOperations.breakdown.trackMetadataReads.toLocaleString()} / ${this.dailyOperations.breakdown.trackMetadataWrites.toLocaleString()}`);
    console.log(`      Telemetry Metadata (R/W): ${this.dailyOperations.breakdown.telemetryMetadataReads.toLocaleString()} / ${this.dailyOperations.breakdown.telemetryMetadataWrites.toLocaleString()}`);
    console.log(`      Alert Checks (R/W):      ${this.dailyOperations.breakdown.alertReads.toLocaleString()} / ${this.dailyOperations.breakdown.alertWrites.toLocaleString()}`);
  }

  /**
   * Print historical daily reports
   */
  printDailyHistory() {
    if (this.dailyReports.length === 0) {
      console.log('\n📅 No historical daily reports available yet.\n');
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('📅 HISTORICAL DAILY REPORTS (Last 30 Days)');
    console.log('='.repeat(80));
    console.log('   Date       | Reads    | Writes   | Deletes  | Est. Cost');
    console.log('   ' + '-'.repeat(76));

    for (const report of this.dailyReports) {
      console.log(
        `   ${report.date} | ${String(report.reads).padStart(8)} | ${String(report.writes).padStart(8)} | ${String(report.deletes).padStart(8)} | $${report.estimatedCost.toFixed(4)}`
      );
    }

    console.log('   ' + '-'.repeat(76));

    // Calculate totals
    const totalReads = this.dailyReports.reduce((sum, r) => sum + r.reads, 0);
    const totalWrites = this.dailyReports.reduce((sum, r) => sum + r.writes, 0);
    const totalDeletes = this.dailyReports.reduce((sum, r) => sum + r.deletes, 0);
    const totalCost = this.dailyReports.reduce((sum, r) => sum + r.estimatedCost, 0);

    console.log(
      `   TOTAL      | ${String(totalReads).padStart(8)} | ${String(totalWrites).padStart(8)} | ${String(totalDeletes).padStart(8)} | $${totalCost.toFixed(4)}`
    );
    console.log('='.repeat(80) + '\n');
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset() {
    for (const key in this.metrics) {
      this.metrics[key] = [];
    }
    
    for (const key in this.counters) {
      this.counters[key] = 0;
    }
    
    this.queueSizes = [];
    this.startTime = Date.now();
    this.lastStatsTime = Date.now();
    this.lastStatsCount = 0;
  }
}

// Singleton instance
export const performanceMonitor = new PerformanceMonitor();
import { Firestore } from '@google-cloud/firestore';

const MAX_HISTORY_SIZE = 50;

export async function trimLocationHistories(projectId) {
  const db = new Firestore({ projectId });

  console.log('🔧 Starting location history maintenance...');

  try {
    const devicesSnapshot = await db.collection('devices').get();
    
    let trimmedCount = 0;
    let skippedCount = 0;

    for (const doc of devicesSnapshot.docs) {
      const data = doc.data();
      const locationHistory = data.locationHistory || [];

      if (locationHistory.length > MAX_HISTORY_SIZE) {
        // Trim to last 50
        const trimmed = locationHistory.slice(-MAX_HISTORY_SIZE);
        
        await doc.ref.update({ locationHistory: trimmed });
        
        trimmedCount++;
        console.log(`  ✂️  Trimmed ${doc.id}: ${locationHistory.length} → ${trimmed.length} points`);
      } else {
        skippedCount++;
      }
    }

    console.log(`✅ Maintenance complete: ${trimmedCount} trimmed, ${skippedCount} skipped`);
  } catch (error) {
    console.error('❌ Maintenance failed:', error);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const projectId = process.env.FIRESTORE_PROJECT_ID;
  await trimLocationHistories(projectId);
  process.exit(0);
}
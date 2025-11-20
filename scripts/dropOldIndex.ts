import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

async function dropOldIndex() {
  const client = new MongoClient(process.env.MONGODB_URI || '');
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db(process.env.MONGODB_DATABASE || 'threespeak');
    const collection = db.collection('embed-video');
    
    // List all indexes first
    const indexes = await collection.indexes();
    console.log('Current indexes:', indexes);
    
    // Drop the old embed_url index if it exists
    try {
      await collection.dropIndex('embed_url_1');
      console.log('✅ Successfully dropped embed_url_1 index');
    } catch (error: any) {
      if (error.code === 27) {
        console.log('ℹ️  Index embed_url_1 does not exist (already dropped)');
      } else {
        throw error;
      }
    }
    
    // List indexes after dropping
    const indexesAfter = await collection.indexes();
    console.log('Indexes after cleanup:', indexesAfter);
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

dropOldIndex();

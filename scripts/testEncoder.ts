import dotenv from 'dotenv';
import { loadConfig } from '../src/config/config';

dotenv.config();

const config = loadConfig();

async function testEncoderDispatch() {
  // Test data
  const rawCid = 'QmWqF8UccwXg6uErzG9dsx42zgw48dHgLpLkLcW4Bp4RxX';
  const testJob = {
    owner: 'testuser',
    permlink: 'test-video-' + Date.now(),
    input_cid: `https://ipfs.3speak.tv/ipfs/${rawCid}`,
    short: false,
    webhook_url: 'https://webhook.site/test', // Will fail but that's ok
    api_key: 'test-webhook-key',
    frontend_app: 'test-app',
    originalFilename: 'test-video.mp4'
  };

  console.log('Testing encoder dispatch...');
  console.log('Encoder:', config.encoders[0]);
  console.log('Job payload:', JSON.stringify(testJob, null, 2));

  try {
    const encoder = config.encoders[0];
    
    if (!encoder) {
      console.error('❌ No encoder configured!');
      return;
    }

    console.log(`\nSending to ${encoder.name} at ${encoder.url}/encode...`);
    
    const response = await fetch(`${encoder.url}/encode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': encoder.apiKey,
      },
      body: JSON.stringify(testJob),
    });

    console.log(`Response status: ${response.status}`);
    
    const contentType = response.headers.get('content-type');
    
    if (contentType?.includes('application/json')) {
      const result = await response.json() as { job_id?: string; estimated_position?: number; status?: string; error?: string };
      console.log('Response body:', JSON.stringify(result, null, 2));

      if (response.ok) {
        console.log('\n✅ Job dispatched successfully!');
        console.log(`Job ID: ${result.job_id}`);
        console.log(`Estimated position: ${result.estimated_position || 'N/A'}`);
        console.log('\nCheck Snapie dashboard to see encoding progress!');
      } else {
        console.error('\n❌ Dispatch failed:', result);
      }
    } else {
      const text = await response.text();
      console.log('Response body (non-JSON):', text.substring(0, 500));
      
      if (response.status === 404) {
        console.error('\n❌ 404 Not Found - Direct API might not be enabled or endpoint is different');
        console.log('\nCheck:');
        console.log('1. Is DIRECT_API_ENABLED=true in Snapie\'s config?');
        console.log('2. Is Snapie running and accessible?');
        console.log('3. Try: curl -X POST https://snapie.3speak.tv/encode');
      }
    }
  } catch (error) {
    console.error('\n❌ Error:', error);
  }
}

testEncoderDispatch();

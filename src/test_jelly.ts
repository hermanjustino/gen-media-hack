import { JellyClient } from './lib/jelly.js';

async function main() {
    const client = new JellyClient();
    const query = process.argv[2] || 'iqram';

    console.log(`\n🚀 Testing JellyJelly API with query: "${query}"...\n`);

    try {
        // 1. Test Search
        console.log('--- [1/2] Searching Jellies ---');
        const searchResult = await client.search({ q: query, page_size: 5 });
        console.log(`Found ${searchResult.total} total jellies. Showing first ${searchResult.jellies.length}:`);

        for (const jelly of searchResult.jellies) {
            console.log(`  - [${jelly.id}] ${jelly.title} (by ${jelly.participants[0]?.username})`);
        }

        if (searchResult.jellies.length > 0) {
            // 2. Test Get By ID
            const firstId = searchResult.jellies[0].id;
            console.log(`\n--- [2/2] Fetching Jelly Details for ID: ${firstId} ---`);
            const details = await client.getById(firstId);
            console.log(`Title: ${details.title}`);
            console.log(`Posted: ${details.posted_at}`);
            console.log(`Views: ${details.all_views ?? 'N/A'}`);
            console.log(`Summary: ${details.summary ?? 'No summary available'}`);
        } else {
            console.log('\n⚠️ No jellies found for this query, skipping details test.');
        }

        console.log('\n✅ API connectivity test successful!\n');

    } catch (error) {
        console.error('\n❌ API test failed:');
        console.error(error);
        process.exit(1);
    }
}

main();


import {
    initializeOfflineDatabase,
    getOfflineDatabaseStatus
} from './database';

import {
    testLocalSaleStorage
} from './checkout';

import {
    checkServerConnection
} from './connection';

export async function testOfflineSystem() {
    console.log('=== STRATIFYPOS OFFLINE TEST ===');

    const database = await initializeOfflineDatabase();

    console.log('Database:', database);

    const status = await getOfflineDatabaseStatus();

    console.log('Storage:', status);

    const connection = await checkServerConnection();

    console.log('Connection:', connection);

    const saleTest = await testLocalSaleStorage();

console.log('Offline sale storage:', saleTest);
}

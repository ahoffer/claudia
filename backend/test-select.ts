#!/usr/bin/env node
/**
 * Test task:select with disconnected tasks
 * This test:
 * 1. Destroys any running task to simulate disconnection
 * 2. Waits for backend restart (auto-reload)
 * 3. Selects the disconnected task to test auto-reconnect
 */
import WebSocket from 'ws';

async function runTest() {
    return new Promise<void>((resolve) => {
        const ws = new WebSocket('ws://localhost:3001');
        let testPhase = 'init';
        let testTaskId: string | null = null;

        ws.on('open', () => {
            console.log('Connected to backend');
        });

        ws.on('message', (data: Buffer) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'init') {
                const tasks = msg.payload.tasks || [];
                console.log(`\nGot ${tasks.length} tasks:`);
                
                tasks.forEach((t: any) => {
                    console.log(`  - ${t.id.substring(0,20)}...: state=${t.state}, prompt="${t.prompt.substring(0,40)}..."`);
                });

                // Check for disconnected task
                const disconnectedTask = tasks.find((t: any) => t.state === 'disconnected');
                
                if (disconnectedTask) {
                    console.log(`\n✅ Found disconnected task: ${disconnectedTask.id}`);
                    console.log('   Sending task:select to trigger auto-reconnect...');
                    testTaskId = disconnectedTask.id;
                    testPhase = 'selecting';
                    
                    ws.send(JSON.stringify({
                        type: 'task:select',
                        payload: { taskId: disconnectedTask.id }
                    }));
                } else {
                    console.log('\n❌ No disconnected tasks found.');
                    console.log('   To test: stop the backend, modify tasks.json to remove a live process, restart backend');
                    ws.close();
                    resolve();
                }
            } else if (msg.type === 'tasks:updated') {
                if (testPhase === 'selecting' && testTaskId) {
                    const tasks = msg.payload.tasks || [];
                    const task = tasks.find((t: any) => t.id === testTaskId);
                    if (task && task.state !== 'disconnected') {
                        console.log(`\n✅ SUCCESS! Task auto-reconnected!`);
                        console.log(`   Task ${task.id.substring(0,20)}... is now: ${task.state}`);
                        testPhase = 'done';
                    }
                }
            } else if (msg.type === 'task:stateChanged') {
                if (testTaskId && msg.payload.task.id === testTaskId) {
                    console.log(`   State changed: ${msg.payload.task.state}`);
                }
            } else if (msg.type === 'task:restore') {
                console.log(`   Got task:restore with ${msg.payload.history?.length || 0} chars of history`);
            } else if (msg.type === 'task:output') {
                const preview = msg.payload.data.substring(0, 60).replace(/[\n\r]/g, '↵');
                console.log(`   Output: ${preview}...`);
            }
        });

        ws.on('close', () => {
            console.log('\nConnection closed');
            resolve();
        });

        // Close after 15 seconds
        setTimeout(() => {
            console.log('\nTest timeout, closing...');
            ws.close();
        }, 15000);
    });
}

runTest().then(() => process.exit(0));

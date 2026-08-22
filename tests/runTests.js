const { startServer } = require('../server');
const { runAllTests } = require('./kiosk.test');

async function main() {
  const server = await startServer(3000);
  try {
    await runAllTests();
    console.log('All tests completed successfully! Exiting.');
    process.exit(0);
  } catch (err) {
    console.error('Test run failed:', err);
    process.exit(1);
  } finally {
    server.close();
  }
}

main();

import { MongoMeasurementStore, MongoProbeStore } from '../../packages/control-plane/dist/index.js';
if (!process.env.MEASUREMENTS_MONGO_URL) throw new Error('MEASUREMENTS_MONGO_URL is required');
const measurements = new MongoMeasurementStore(process.env.MEASUREMENTS_MONGO_URL, process.env.MEASUREMENTS_MONGO_CA_FILE);
try {
  await measurements.initialize();
  await new MongoProbeStore(measurements).initialize();
  console.log('Mongo measurement and probes queue indexes verified. PostgreSQL unchanged.');
} finally { await measurements.close(); }

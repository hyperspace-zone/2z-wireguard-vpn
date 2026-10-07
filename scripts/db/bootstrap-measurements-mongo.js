// Run locally on an empty Mongo host using the localhost exception. No secrets
// in arguments, logs or git. Never reset credentials of an existing database.
const fs = require('fs');
const dir = '/etc/hyperspace/mongodb';
const admin = db.getSiblingDB('admin');
admin.createUser({user:'hs_mongo_admin',pwd:fs.readFileSync(dir+'/admin-password','utf8').trim(),roles:['root']});
admin.auth('hs_mongo_admin',fs.readFileSync(dir+'/admin-password','utf8').trim());
const measurements = db.getSiblingDB('hyperspace_measurements');
const password = fs.readFileSync(dir+'/app-password','utf8').trim();
measurements.createUser({user:'hs_measurements',pwd:password,roles:[{role:'readWrite',db:'hyperspace_measurements'}]});
fs.writeFileSync('/etc/hyperspace/measurements-mongo.env',
  'MEASUREMENTS_MONGO_URL=mongodb://hs_measurements:'+password+'@88.216.62.149:27017/hyperspace_measurements?authSource=hyperspace_measurements&tls=true&retryWrites=false\n'+
  'MEASUREMENTS_MONGO_CA_FILE=/etc/hyperspace/mongodb/ca.crt\n',{mode:0o600});
print('Mongo users and private runtime environment created.');

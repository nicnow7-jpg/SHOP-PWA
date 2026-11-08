// Local development only: node --env-file=.env server.js
const express = require('express'), path = require('path'), app = require('./app');
app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('Shop running on http://localhost:' + (process.env.PORT || 3000)));

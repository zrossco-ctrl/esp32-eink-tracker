require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const sharp = require('sharp');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware to parse JSON request bodies
app.use(express.json());

// Serve static frontend files if you have an 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------
// 1. MONGODB CONNECTION
// ------------------------------------------------------------------
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("ERROR: MONGO_URI environment variable is missing!");
  process.exit(1);
}

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas.'))
  .catch(err => console.error('MongoDB connection error:', err));

// ------------------------------------------------------------------
// 2. DATABASE SCHEMAS & MODELS
// ------------------------------------------------------------------
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const deviceSchema = new mongoose.Schema({
  macAddress: { type: String, required: true, unique: true },
  deviceName: { type: String, default: 'Unnamed ESP32 Device' },
  assignedUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  lastSeen: { type: Date, default: Date.now }
});
const Device = mongoose.model('Device', deviceSchema);

// ------------------------------------------------------------------
// 3. API ROUTES FOR USER & DEVICE MANAGEMENT
// ------------------------------------------------------------------

// Get all users (To populate your frontend dropdown)
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ name: 1 });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new user
app.post('/api/users', async (req, res) => {
  try {
    const { name, email } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const newUser = new User({ name, email });
    await newUser.save();
    res.status(201).json(newUser);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get all devices (including their populated assigned user details)
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await Device.find().populate('assignedUser');
    res.json(devices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Register or update a device (useful when the ESP32 pings the server)
app.post('/api/devices/register', async (req, res) => {
  const { macAddress, deviceName } = req.body;
  if (!macAddress) return res.status(400).json({ error: 'macAddress is required' });

  try {
    const device = await Device.findOneAndUpdate(
      { macAddress },
      { deviceName, lastSeen: Date.now() },
      { new: true, upsert: true }
    );
    res.json(device);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Assign or unassign a user to a specific device
app.post('/api/devices/assign', async (req, res) => {
  const { deviceId, userId } = req.body;
  
  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  try {
    // If no userId is sent, or it's an empty string, set it to null (Unassigned)
    const targetUserId = userId ? userId : null;

    const updatedDevice = await Device.findByIdAndUpdate(
      deviceId,
      { assignedUser: targetUserId },
      { new: true }
    ).populate('assignedUser');

    if (!updatedDevice) {
      return res.status(404).json({ error: 'Device not found' });
    }
    
    res.json(updatedDevice);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ------------------------------------------------------------------
// 4. E-INK FLIGHT TRACKER IMAGE PROCESSING (Placeholder example logic)
// ------------------------------------------------------------------
app.get('/api/flight-image', async (req, res) => {
  try {
    // Example: Fetch or generate image processing pipeline using sharp
    // This is where your ESP32 E-Ink display can fetch optimized bitmap streams
    const width = 296;  // Standard 2.9" E-Ink dimensions
    const height = 128;

    const processedImageBuffer = await sharp({
      create: {
        width,
        height,
        channels: 1,
        background: { r: 255, g: 255, b: 255 }
      }
    })
    .png()
    .toBuffer();

    res.type('image/png');
    res.send(processedImageBuffer);
  } catch (err) {
    res.status(500).json({ error: 'Image processing failed: ' + err.message });
  }
});

// ------------------------------------------------------------------
// 5. SERVER INITIALIZATION
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

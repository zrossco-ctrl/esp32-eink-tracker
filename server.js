const express = require('express');
const mongoose = require('mongoose');
const sharp = require('sharp');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

// Connect to Database
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Database connected"))
  .catch(err => console.error("Database connection error:", err));

// Database Schema
const DeviceSchema = new mongoose.Schema({
  macAddress: { type: String, unique: true, required: true },
  latitude: { type: Number, default: 51.5074 },
  longitude: { type: Number, default: -0.1278 },
  scanRadiusKm: { type: Number, default: 50 },
  width: { type: Number, default: 200 },
  height: { type: Number, default: 200 },
  pendingNotification: { type: String, default: null } 
});
const Device = mongoose.model('Device', DeviceSchema);

// Main Endpoint called by ESP32
app.post('/api/device/heartbeat', async (req, res) => {
  const { macAddress, width = 200, height = 200 } = req.body;

  try {
    let device = await Device.findOne({ macAddress });
    if (!device) {
      device = await Device.create({ macAddress, width, height });
    }

    // Default flight details for testing initial setup
    let flightText = "No Flights Found";
    
    // Live OpenSky API Integration
    try {
      // Calculate Bounding Box (~50km)
      const latDelta = device.scanRadiusKm / 111;
      const lonDelta = device.scanRadiusKm / (111 * Math.cos(device.latitude * Math.PI / 180));
      
      const lamin = device.latitude - latDelta;
      const lamax = device.latitude + latDelta;
      const lomin = device.longitude - lonDelta;
      const lomax = device.longitude + lonDelta;

      const response = await axios.get(`https://opensky-network.org/api/states/all?lamin=${lamin}&lamax=${lamax}&lomin=${lomin}&lomax=${lomax}`, { timeout: 5000 });
      
      if (response.data && response.data.states && response.data.states.length > 0) {
        const f = response.data.states[0]; // Grab the first local flight
        const callsign = f[1].trim() || "UNKNOWN";
        const altitude = f[7] ? Math.round(f[7] * 3.28084) : 0; // meters to feet
        const speed = f[9] ? Math.round(f[9] * 1.94384) : 0; // m/s to knots
        
        flightText = `${callsign}\nALT: ${altitude}ft\nSPD: ${speed}kts`;
      }
    } catch (apiErr) {
      console.log("Aviation API timed out or limits reached, using cached layout.");
      flightText = "API Rate Limit\nRetrying soon...";
    }

    // Process notification alerts
    let notificationOverlay = "";
    if (device.pendingNotification) {
      notificationOverlay = `ALERT: ${device.pendingNotification}`;
      device.pendingNotification = null;
      await device.save();
    }

    // Fixed the syntax error by building strings with single quotes to protect the outer backticks
    const flightLines = flightText.split('\n').map((line, i) => {
      const dyVal = i === 0 ? 0 : 18;
      return '<tspan x="10" dy="' + dyVal + '">' + line + '</tspan>';
    }).join('');

    // Generate E-Ink Canvas Grid
    const svgContent = `
      <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
        <rect width="100%" height="100%" fill="white"/>
        <text x="10" y="25" font-family="monospace" font-size="14" fill="black" font-weight="bold">RADAR ACTIVE</text>
        <line x1="10" y1="35" x2="${width - 10}" y2="35" stroke="black" stroke-width="1.5"/>
        
        <!-- Flight Info Layout -->
        <text x="10" y="60" font-family="monospace" font-size="12" fill="black">
          ${flightLines}
        </text>

        <!-- Push alert banner -->
        <text x="10" y="${height - 20}" font-family="monospace" font-size="11" fill="black" font-weight="bold">${notificationOverlay}</text>
      </svg>
    `;

    // Process SVG into monochrome binary stream
    const rawBuffer = await sharp(Buffer.from(svgContent)).resize(width, height).grayscale().threshold(128).raw().toBuffer();
    const einkBuffer = Buffer.alloc(rawBuffer.length / 8);
    
    for (let i = 0; i < rawBuffer.length; i++) {
      const pixel = rawBuffer[i] > 128 ? 1 : 0;
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      if (pixel) einkBuffer[byteIndex] |= (1 << bitIndex);
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(einkBuffer);

  } catch (error) {
    res.status(500).json({ error: "Server error generating display array" });
  }
});

// Admin panel controls
app.post('/api/admin/update-device', async (req, res) => {
  const { macAddress, latitude, longitude, scanRadiusKm, message } = req.body;
  try {
    const updateData = {};
    if (latitude) updateData.latitude = latitude;
    if (longitude) updateData.longitude = longitude;
    if (scanRadiusKm) updateData.scanRadiusKm = scanRadiusKm;
    if (message) updateData.pendingNotification = message;

    const device = await Device.findOneAndUpdate({ macAddress }, updateData, { new: true, upsert: true });
    return res.json({ status: "Updated", device });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Serve the Admin Dashboard Interface directly to your browser
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>E-Ink Radar Console</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen font-sans p-4">
    <div class="max-w-md mx-auto space-y-4">
        <header class="bg-slate-800 p-4 rounded-xl shadow-lg border border-slate-700">
            <h1 class="text-xl font-bold tracking-wider text-teal-400 text-center">📡 E-INK RADAR CONSOLE</h1>
        </header>
        <div class="bg-slate-800 rounded-xl shadow-lg border border-slate-700 overflow-hidden">
            <div id="map" class="h-64 w-full z-10"></div>
            <p class="text-xs text-slate-400 p-2 text-center bg-slate-850">Click anywhere on the map to set a new tracker location</p>
        </div>
        <div class="bg-slate-800 p-4 rounded-xl shadow-lg border border-slate-700 space-y-4">
            <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Target MAC Address</label>
                <input type="text" id="macAddress" placeholder="24:0A:C4:XX:XX:XX" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-teal-300 focus:outline-none focus:border-teal-500">
            </div>
            <div class="grid grid-cols-2 gap-2">
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Latitude</label>
                    <input type="number" id="lat" step="0.0001" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none">
                </div>
                <div>
                    <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Longitude</label>
                    <input type="number" id="lng" step="0.0001" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none">
                </div>
            </div>
            <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Scan Range: <span id="rangeVal" class="text-teal-400 font-bold">50</span> km</label>
                <input type="range" id="scanRadius" min="10" max="150" value="50" class="w-full accent-teal-500 h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer">
            </div>
            <hr class="border-slate-700">
            <div>
                <label class="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Push Alert/Message</label>
                <input type="text" id="message" placeholder="Type a notice to print on screen..." class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-amber-300 focus:outline-none focus:border-amber-500">
            </div>
            <button onclick="updateSettings()" class="w-full bg-gradient-to-r from-teal-500 to-emerald-600 hover:from-teal-600 hover:to-emerald-700 text-white font-bold py-2 px-4 rounded-lg shadow transition active:scale-[0.98]">
                Deploy Updates
            </button>
        </div>
    </div>
    <script>
        const map = L.map('map').setView([51.5074, -0.1278], 7);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);
        let marker = null; let radarCircle = null;
        const slider = document.getElementById('scanRadius');
        const rangeVal = document.getElementById('rangeVal');
        slider.addEventListener('input', (e) => {
            rangeVal.innerText = e.target.value;
            if(radarCircle) radarCircle.setRadius(e.target.value * 1000);
        });
        map.on('click', function(e) {
            const lat = e.latlng.lat.toFixed(4);
            const lng = e.latlng.lng.toFixed(4);
            document.getElementById('lat').value = lat;
            document.getElementById('lng').value = lng;
            updateVisuals(lat, lng, slider.value);
        });
        function updateVisuals(lat, lng, radiusKm) {
            if (marker) map.removeLayer(marker);
            if (radarCircle) map.removeLayer(radarCircle);
            marker = L.marker([lat, lng]).addTo(map);
            radarCircle = L.circle([lat, lng], {
                color: '#14b8a6', fillColor: '#14b8a6', fillOpacity: 0.15, radius: radiusKm * 1000
            }).addTo(map);
        }
        async function updateSettings() {
            const macAddress = document.getElementById('macAddress').value.trim();
            const latitude = parseFloat(document.getElementById('lat').value);
            const longitude = parseFloat(document.getElementById('lng').value);
            const scanRadiusKm = parseInt(slider.value);
            const message = document.getElementById('message').value.trim();
            if (!macAddress) { alert('Please enter your ESP32 MAC address first.'); return; }
            const response = await fetch('/api/admin/update-device', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ macAddress, latitude, longitude, scanRadiusKm, message })
            });
            if (response.ok) {
                alert('Configuration synced!');
                document.getElementById('message').value = '';
            } else {
                alert('Sync failed.');
            }
        }
    </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server online on port ${PORT}`));

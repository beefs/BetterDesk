/**
 * BetterDesk Console - CDAP Routes
 * Routes for CDAP (Custom Device Automation Protocol) device management
 * and widget rendering in the admin panel.
 */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const betterdeskApi = require('../services/betterdeskApi');

// ── Page Routes ──────────────────────────────────────────────────────────

/**
 * CDAP device detail page with widget panel
 * GET /cdap/devices/:id
 */
router.get('/cdap/devices/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        res.render('cdap-device', {
            title: req.__('cdap.device_detail'),
            activePage: 'devices',
            deviceId: id
        });
    } catch (err) {
        console.error('CDAP device page error:', err.message);
        res.redirect('/devices');
    }
});

// ── API Routes ───────────────────────────────────────────────────────────

/**
 * GET /api/cdap/status
 * Returns CDAP gateway status (enabled, connections, port)
 */
router.get('/api/cdap/status', requireAuth, async (req, res) => {
    try {
        const result = await betterdeskApi.getCDAPStatus();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to get CDAP status' });
    }
});

/**
 * GET /api/cdap/devices
 * Returns all connected CDAP devices
 */
router.get('/api/cdap/devices', requireAuth, async (req, res) => {
    try {
        const result = await betterdeskApi.getCDAPDevices();
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to list CDAP devices' });
    }
});

/**
 * GET /api/cdap/devices/:id
 * Returns full CDAP device info (manifest + state + connection)
 */
router.get('/api/cdap/devices/:id', requireAuth, async (req, res) => {
    try {
        const result = await betterdeskApi.getCDAPDeviceInfo(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to get CDAP device info' });
    }
});

/**
 * GET /api/cdap/devices/:id/manifest
 * Returns device manifest (capabilities, widgets, alerts)
 */
router.get('/api/cdap/devices/:id/manifest', requireAuth, async (req, res) => {
    try {
        const result = await betterdeskApi.getCDAPDeviceManifest(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to get CDAP device manifest' });
    }
});

/**
 * GET /api/cdap/devices/:id/state
 * Returns current widget values for connected device
 */
router.get('/api/cdap/devices/:id/state', requireAuth, async (req, res) => {
    try {
        const result = await betterdeskApi.getCDAPDeviceState(req.params.id);
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to get CDAP device state' });
    }
});

/**
 * POST /api/cdap/devices/:id/command
 * Sends a command to a connected CDAP device
 * Body: { widget_id, action, value, reason? }
 */
router.post('/api/cdap/devices/:id/command', requireAuth, requireRole('operator'), async (req, res) => {
    try {
        const { widget_id, action, value, reason } = req.body;

        if (!widget_id || !action) {
            return res.status(400).json({ success: false, error: 'widget_id and action are required' });
        }

        const result = await betterdeskApi.sendCDAPCommand(
            req.params.id,
            widget_id,
            action,
            value,
            reason
        );
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to send command' });
    }
});

module.exports = router;

package cdap

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/events"
)

// handleRegister processes the "register" message after authentication.
// It parses the manifest, creates/updates the peer in the database, and
// registers the device connection in the gateway's in-memory map.
func (g *Gateway) handleRegister(ctx context.Context, dc *DeviceConn) error {
	msg, err := dc.ReadMessage(ctx)
	if err != nil {
		return fmt.Errorf("read register message: %w", err)
	}
	if msg.Type != "register" {
		return fmt.Errorf("expected 'register' message, got '%s'", msg.Type)
	}

	var rp RegisterPayload
	if err := json.Unmarshal(msg.Payload, &rp); err != nil {
		return fmt.Errorf("invalid register payload: %w", err)
	}
	if rp.Manifest == nil {
		return fmt.Errorf("manifest is required")
	}

	// Validate manifest
	if err := ValidateManifest(rp.Manifest); err != nil {
		return fmt.Errorf("invalid manifest: %w", err)
	}

	dc.Manifest = rp.Manifest
	dc.HeartbeatInterval = rp.Manifest.HeartbeatInterval

	// Validate device ID format (CDAP-XXXXXXXX or 6-16 alphanumeric)
	if dc.ID == "" {
		return fmt.Errorf("device_id is required (set in auth payload)")
	}

	// Check if device is banned
	banned, _ := g.db.IsPeerBanned(dc.ID)
	if banned {
		return fmt.Errorf("device is banned")
	}

	// Check if device is soft-deleted
	deleted, _ := g.db.IsPeerSoftDeleted(dc.ID)
	if deleted {
		return fmt.Errorf("device has been deleted")
	}

	// Upsert the peer in the database
	tags := strings.Join(rp.Manifest.Device.Tags, ",")
	peer := &db.Peer{
		ID:         dc.ID,
		Hostname:   rp.Manifest.Device.Name,
		Status:     "ONLINE",
		IP:         dc.ClientIP,
		DeviceType: rp.Manifest.Device.Type,
		Tags:       tags,
		User:       dc.Username,
		LastOnline: time.Now(),
		OS:         rp.Manifest.Bridge.Protocol,
		Version:    rp.Manifest.Bridge.Version,
	}
	if err := g.db.UpsertPeer(peer); err != nil {
		return fmt.Errorf("save peer: %w", err)
	}

	// Store manifest JSON in config (device-specific key)
	manifestJSON, _ := json.Marshal(rp.Manifest)
	g.db.SetConfig(fmt.Sprintf("cdap_manifest_%s", dc.ID), string(manifestJSON))

	// Check for existing connection with same ID (force disconnect old)
	if old, loaded := g.devices.LoadAndDelete(dc.ID); loaded {
		if oldDC, ok := old.(*DeviceConn); ok {
			log.Printf("[cdap] %s: replacing existing connection from %s", dc.ID, oldDC.ClientIP)
			oldDC.Close(4001, "replaced by new connection")
		}
	}

	// Register in gateway's device map
	g.devices.Store(dc.ID, dc)

	// Update peer status to ONLINE
	g.db.UpdatePeerStatus(dc.ID, "ONLINE", dc.ClientIP)

	// Send registration confirmation
	result := map[string]any{
		"device_id":   dc.ID,
		"server_time": time.Now().UTC().Format(time.RFC3339),
	}
	if err := sendMessage(ctx, dc.conn, "registered", result); err != nil {
		return fmt.Errorf("send registered: %w", err)
	}

	// Publish connect event
	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: "cdap_connect",
			Data: map[string]string{
				"peer_id":     dc.ID,
				"device_type": rp.Manifest.Device.Type,
				"device_name": rp.Manifest.Device.Name,
				"username":    dc.Username,
			},
		})
	}

	g.auditAction("cdap_register", dc.ID, map[string]string{
		"device_name": rp.Manifest.Device.Name,
		"device_type": rp.Manifest.Device.Type,
		"widgets":     fmt.Sprintf("%d", len(rp.Manifest.Widgets)),
		"ip":          dc.ClientIP,
	})

	log.Printf("[cdap] %s: registered (type=%s, name=%s, widgets=%d, heartbeat=%ds)",
		dc.ID, rp.Manifest.Device.Type, rp.Manifest.Device.Name,
		len(rp.Manifest.Widgets), rp.Manifest.HeartbeatInterval)

	return nil
}

// handleHeartbeat processes periodic heartbeat messages.
func (g *Gateway) handleHeartbeat(ctx context.Context, dc *DeviceConn, msg *Message) {
	dc.LastHeartbeat = time.Now()
	dc.HeartbeatCount.Add(1)

	var payload HeartbeatPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3001, "invalid heartbeat payload")
		return
	}

	// Save system metrics if provided
	if payload.Metrics != nil {
		m := payload.Metrics
		if m.CPU > 0 || m.Memory > 0 || m.Disk > 0 {
			g.db.SavePeerMetric(dc.ID, m.CPU, m.Memory, m.Disk)
		}
	}

	// Update widget values
	if payload.WidgetValues != nil {
		for widgetID, value := range payload.WidgetValues {
			dc.widgetState.Store(widgetID, value)
		}

		// Publish widget state update event
		if g.eventBus != nil {
			valuesJSON, _ := json.Marshal(payload.WidgetValues)
			g.eventBus.Publish(events.Event{
				Type: "cdap_widget_update",
				Data: map[string]string{
					"peer_id": dc.ID,
					"values":  string(valuesJSON),
				},
			})
		}
	}

	// Keep peer ONLINE
	g.db.UpdatePeerStatus(dc.ID, "ONLINE", dc.ClientIP)

	// Respond with server ping
	sendMessage(ctx, dc.conn, "ping", map[string]any{
		"server_time": time.Now().UTC().Format(time.RFC3339),
	})
}

// handleStateUpdate processes a single widget state update.
func (g *Gateway) handleStateUpdate(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload StateUpdatePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3002, "invalid state_update payload")
		return
	}

	if payload.WidgetID == "" {
		sendError(ctx, dc.conn, 3003, "widget_id is required")
		return
	}

	// Update cached state
	dc.widgetState.Store(payload.WidgetID, payload.Value)

	// Publish to event bus for real-time panel updates
	if g.eventBus != nil {
		valueJSON, _ := json.Marshal(payload.Value)
		g.eventBus.Publish(events.Event{
			Type: "cdap_state_update",
			Data: map[string]string{
				"peer_id":   dc.ID,
				"widget_id": payload.WidgetID,
				"value":     string(valueJSON),
			},
		})
	}
}

// handleBulkUpdate processes multiple widget state updates at once.
func (g *Gateway) handleBulkUpdate(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload BulkUpdatePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3004, "invalid bulk_update payload")
		return
	}

	updates := make(map[string]any, len(payload.Updates))
	for _, u := range payload.Updates {
		if u.WidgetID != "" {
			dc.widgetState.Store(u.WidgetID, u.Value)
			updates[u.WidgetID] = u.Value
		}
	}

	if g.eventBus != nil && len(updates) > 0 {
		valuesJSON, _ := json.Marshal(updates)
		g.eventBus.Publish(events.Event{
			Type: "cdap_widget_update",
			Data: map[string]string{
				"peer_id": dc.ID,
				"values":  string(valuesJSON),
			},
		})
	}
}

// handleCommandResponse processes a device's response to a command.
func (g *Gateway) handleCommandResponse(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload CommandResponsePayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3005, "invalid command_response payload")
		return
	}

	// Publish to event bus so the panel can display the result
	if g.eventBus != nil {
		resultJSON, _ := json.Marshal(payload)
		g.eventBus.Publish(events.Event{
			Type: "cdap_command_response",
			Data: map[string]string{
				"peer_id":    dc.ID,
				"command_id": payload.CommandID,
				"status":     payload.Status,
				"result":     string(resultJSON),
			},
		})
	}

	g.auditAction("cdap_command_response", dc.ID, map[string]string{
		"command_id": payload.CommandID,
		"status":     payload.Status,
		"ip":         dc.ClientIP,
	})
}

// handleEvent processes custom events from the device.
func (g *Gateway) handleEvent(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload EventPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3006, "invalid event payload")
		return
	}

	if g.eventBus != nil {
		dataJSON, _ := json.Marshal(payload.Data)
		g.eventBus.Publish(events.Event{
			Type: "cdap_event",
			Data: map[string]string{
				"peer_id":    dc.ID,
				"event_type": payload.EventType,
				"data":       string(dataJSON),
			},
		})
	}
}

// handleLog processes log entries from the device.
func (g *Gateway) handleLog(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload LogPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3007, "invalid log payload")
		return
	}

	// Log at appropriate level
	level := strings.ToLower(payload.Level)
	if level == "error" || level == "critical" {
		log.Printf("[cdap] %s [%s]: %s", dc.ID, level, payload.Message)
	}

	// Publish to event bus
	if g.eventBus != nil {
		g.eventBus.Publish(events.Event{
			Type: "cdap_log",
			Data: map[string]string{
				"peer_id": dc.ID,
				"level":   payload.Level,
				"message": payload.Message,
			},
		})
	}
}

// handleUnregister processes a graceful disconnect from the device.
func (g *Gateway) handleUnregister(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload UnregisterPayload
	json.Unmarshal(msg.Payload, &payload) // best-effort parse

	log.Printf("[cdap] %s: unregistered (reason: %s)", dc.ID, payload.Reason)

	g.auditAction("cdap_unregister", dc.ID, map[string]string{
		"reason": payload.Reason,
		"ip":     dc.ClientIP,
	})
}

// handleTokenRefresh refreshes the device's JWT token.
func (g *Gateway) handleTokenRefresh(ctx context.Context, dc *DeviceConn, msg *Message) {
	var payload TokenRefreshPayload
	if err := json.Unmarshal(msg.Payload, &payload); err != nil {
		sendError(ctx, dc.conn, 3008, "invalid token_refresh payload")
		return
	}

	// Validate the existing token
	claims, err := g.jwt.Validate(dc.Token)
	if err != nil {
		sendError(ctx, dc.conn, 1003, "current token invalid")
		return
	}

	// Generate new token
	newToken, err := g.jwt.Generate(claims.Sub, dc.Role)
	if err != nil {
		sendError(ctx, dc.conn, 5001, "failed to generate token")
		return
	}

	dc.Token = newToken
	dc.TokenExpiry = time.Now().Add(g.jwt.Expiry())

	sendMessage(ctx, dc.conn, "token_refreshed", map[string]any{
		"token":      newToken,
		"expires_at": dc.TokenExpiry.UTC().Format(time.RFC3339),
	})
}

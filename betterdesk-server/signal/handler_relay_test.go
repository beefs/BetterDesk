package signal

import (
	"net"
	"testing"
	"time"

	"github.com/unitronix/betterdesk-server/config"
	"github.com/unitronix/betterdesk-server/crypto"
	"github.com/unitronix/betterdesk-server/db"
	"github.com/unitronix/betterdesk-server/peer"
	pb "github.com/unitronix/betterdesk-server/proto"
	"google.golang.org/protobuf/proto"
)

func TestPendingRelayByInitiatorRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfg := config.DefaultConfig()
	cfg.DBPath = dir + "/relay_test.db"
	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	s := New(cfg, kp, database)

	key := "127.0.0.1:7777"
	uuid := "377076f3-85cb-40c9-8b28-38c226b7f6d4"
	targetID := "A12345678"
	s.storePendingRelayByInitiator(key, uuid, targetID)

	p := s.getPendingRelayByInitiator(key)
	if p == nil {
		t.Fatal("expected pending entry")
	}
	if p.uuid != uuid || p.targetID != targetID {
		t.Fatalf("got uuid=%q targetID=%q", p.uuid, p.targetID)
	}
}

// TestRelayResponseForwardRecoversFromInitiatorPending verifies that when two
// peers could match FindByIP (same public IP), initiator-keyed pending relay
// still yields the correct relay UUID and target PK (LAN / shared-NAT case).
func TestRelayResponseForwardRecoversFromInitiatorPending(t *testing.T) {
	dir := t.TempDir()
	cfg := config.DefaultConfig()
	cfg.DBPath = dir + "/relay_test2.db"
	database, err := db.OpenSQLite(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	database.Migrate()
	defer database.Close()

	kp, err := crypto.GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	srv := New(cfg, kp, database)

	uc, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer uc.Close()
	srv.udpConn = uc

	recv, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer recv.Close()

	// Single peer on this IP so UDP fallback delivery is deterministic.
	// (When several peers share one public IP, FindByIP is ambiguous; the
	// initiator-keyed pending store fixes UUID/targetID before that lookup.)

	targetID := "A12345678"
	pk := make([]byte, 32)
	for i := range pk {
		pk[i] = byte(i + 1)
	}
	srv.peers.Put(&peer.Entry{
		ID:        targetID,
		PK:        pk,
		LastReg:   time.Now(),
		UDPAddr:   recv.LocalAddr().(*net.UDPAddr),
	})

	initiatorUDP := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 7777}
	key := normalizeAddrKey(initiatorUDP.String())
	expectedUUID := "377076f3-85cb-40c9-8b28-38c226b7f6d4"
	srv.storePendingRelayByInitiator(key, expectedUUID, targetID)

	msg := &pb.RendezvousMessage{
		Union: &pb.RendezvousMessage_RelayResponse{
			RelayResponse: &pb.RelayResponse{
				SocketAddr: crypto.EncodeAddr(initiatorUDP),
			},
		},
	}
	senderAddr := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 50000}
	srv.handleRelayResponseForward(msg, senderAddr)

	buf := make([]byte, 65536)
	_ = recv.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := recv.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("recv UDP: %v", err)
	}

	var out pb.RendezvousMessage
	if err := proto.Unmarshal(buf[:n], &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	rr := out.GetRelayResponse()
	if rr == nil {
		t.Fatal("expected RelayResponse")
	}
	if rr.Uuid != expectedUUID {
		t.Fatalf("uuid: got %q want %q", rr.Uuid, expectedUUID)
	}
	signedPk := rr.GetPk()
	if len(signedPk) == 0 {
		t.Fatal("expected signed PK")
	}
	// Signature must be for the intended target, not the peer FindByIP might return first.
	ref, err := kp.SignIdPk(targetID, pk)
	if err != nil {
		t.Fatal(err)
	}
	if string(signedPk) != string(ref) {
		t.Fatal("signed PK does not match target A12345678")
	}
}

'use client';

import { useState, useEffect, useRef } from 'react';
import LiveStreamViewer from '@/components/LiveStreamViewer';
import LiveStreamBroadcaster from '@/components/LiveStreamBroadcaster';

export default function Home() {
  const [roomId, setRoomId] = useState('');
  const [userType, setUserType] = useState<'broadcaster' | 'viewer' | null>(null);
  const [userId] = useState(() => `user-${Math.random().toString(36).substr(2, 9)}`);

  return (
    <main style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ marginBottom: '2rem' }}>WebRTC Live Streaming Test</h1>
      
      {!userType ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '400px' }}>
          <input
            type="text"
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            style={{ padding: '0.5rem', fontSize: '1rem' }}
          />
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={() => setUserType('broadcaster')}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                cursor: 'pointer',
                backgroundColor: '#0070f3',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                flex: 1
              }}
            >
              Start Broadcasting
            </button>
            <button
              onClick={() => setUserType('viewer')}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                cursor: 'pointer',
                backgroundColor: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                flex: 1
              }}
            >
              Join as Viewer
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            onClick={() => setUserType(null)}
            style={{
              padding: '0.5rem 1rem',
              marginBottom: '1rem',
              cursor: 'pointer',
              backgroundColor: '#dc3545',
              color: 'white',
              border: 'none',
              borderRadius: '4px'
            }}
          >
            Leave Room
          </button>
          
          {userType === 'broadcaster' ? (
            <LiveStreamBroadcaster roomId={roomId} userId={userId} />
          ) : (
            <LiveStreamViewer roomId={roomId} userId={userId} />
          )}
        </div>
      )}
    </main>
  );
}









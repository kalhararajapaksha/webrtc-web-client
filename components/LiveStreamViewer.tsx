'use client';

import { useEffect, useRef, useState } from 'react';
import { WebRTCManager } from '@/lib/webrtc';

interface LiveStreamViewerProps {
  roomId: string;
  userId: string;
}

export default function LiveStreamViewer({ roomId, userId }: LiveStreamViewerProps) {
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const webrtcRef = useRef<WebRTCManager | null>(null);

  useEffect(() => {
    const webrtc = new WebRTCManager({
      signalingServerUrl: process.env.NEXT_PUBLIC_SIGNALING_URL || 'http://localhost:3001',
      roomId,
      userId,
      userType: 'viewer',
    });

    webrtcRef.current = webrtc;

    webrtc.initialize(
      (stream, streamUserId) => {
        console.log('Received remote stream from:', streamUserId);
        setRemoteStreams((prev) => {
          const newMap = new Map(prev);
          newMap.set(streamUserId, stream);
          return newMap;
        });
        
        // Display the first stream
        if (remoteVideoRef.current && !remoteVideoRef.current.srcObject) {
          remoteVideoRef.current.srcObject = stream;
        }
      },
      (userId) => console.log('Broadcaster joined:', userId),
      (userId) => {
        console.log('Broadcaster left:', userId);
        setRemoteStreams((prev) => {
          const newMap = new Map(prev);
          newMap.delete(userId);
          return newMap;
        });
        
        // If the displayed stream left, show the next one
        if (remoteVideoRef.current?.srcObject) {
          const currentStream = remoteVideoRef.current.srcObject as MediaStream;
          const currentUserId = Array.from(remoteStreams.entries())
            .find(([_, stream]) => stream === currentStream)?.[0];
          
          if (currentUserId === userId) {
            const nextStream = Array.from(remoteStreams.values())[0];
            if (nextStream) {
              remoteVideoRef.current.srcObject = nextStream;
            } else {
              remoteVideoRef.current.srcObject = null;
            }
          }
        }
      }
    );

    return () => {
      webrtc.disconnect();
    };
  }, [roomId, userId]);

  // Update video element when streams change
  useEffect(() => {
    if (remoteVideoRef.current && remoteStreams.size > 0) {
      const firstStream = Array.from(remoteStreams.values())[0];
      if (remoteVideoRef.current.srcObject !== firstStream) {
        remoteVideoRef.current.srcObject = firstStream;
      }
    }
  }, [remoteStreams]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ 
        backgroundColor: '#000', 
        borderRadius: '8px', 
        overflow: 'hidden',
        position: 'relative',
        width: '100%',
        maxWidth: '1280px',
        aspectRatio: '16/9'
      }}>
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }}
        />
        {remoteStreams.size === 0 && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'white',
            textAlign: 'center'
          }}>
            <p>Waiting for broadcaster...</p>
          </div>
        )}
      </div>

      <div style={{ 
        padding: '1rem', 
        backgroundColor: '#f8f9fa', 
        borderRadius: '4px',
        fontSize: '0.9rem'
      }}>
        <p><strong>Room ID:</strong> {roomId}</p>
        <p><strong>User ID:</strong> {userId}</p>
        <p><strong>Status:</strong> {remoteStreams.size > 0 ? '🟢 Receiving Stream' : '⚪ Waiting'}</p>
        <p><strong>Active Streams:</strong> {remoteStreams.size}</p>
      </div>
    </div>
  );
}









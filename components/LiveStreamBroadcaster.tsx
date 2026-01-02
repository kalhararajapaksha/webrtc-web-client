'use client';

import { useEffect, useRef, useState } from 'react';
import { WebRTCManager, StreamType } from '@/lib/webrtc';

interface LiveStreamBroadcasterProps {
  roomId: string;
  userId: string;
}

export default function LiveStreamBroadcaster({ roomId, userId }: LiveStreamBroadcasterProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamType, setStreamType] = useState<StreamType>('camera');
  const webrtcRef = useRef<WebRTCManager | null>(null);

  useEffect(() => {
    const webrtc = new WebRTCManager({
      signalingServerUrl: process.env.NEXT_PUBLIC_SIGNALING_URL || 'http://localhost:3001',
      roomId,
      userId,
      userType: 'broadcaster',
    });

    webrtcRef.current = webrtc;

    webrtc.initialize(
      undefined, // onRemoteStream (not needed for broadcaster)
      (userId) => console.log('Viewer joined:', userId),
      (userId) => console.log('Viewer left:', userId)
    );

    return () => {
      webrtc.disconnect();
    };
  }, [roomId, userId]);

  const startStreaming = async () => {
    try {
      const stream = await webrtcRef.current?.startStream(streamType);
      if (stream && localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        setIsStreaming(true);
      }
    } catch (error) {
      console.error('Failed to start streaming:', error);
      alert('Failed to start streaming. Please check permissions.');
    }
  };

  const stopStreaming = async () => {
    await webrtcRef.current?.stopStream();
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    setIsStreaming(false);
  };

  const switchStream = async () => {
    const newType = streamType === 'camera' ? 'screen' : 'camera';
    setStreamType(newType);
    
    if (isStreaming) {
      try {
        const stream = await webrtcRef.current?.switchStreamType(newType);
        if (stream && localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
      } catch (error) {
        console.error('Failed to switch stream:', error);
        alert('Failed to switch stream type.');
      }
    }
  };

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
          ref={localVideoRef}
          autoPlay
          muted
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain'
          }}
        />
        {!isStreaming && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            color: 'white',
            textAlign: 'center'
          }}>
            <p>Click "Start Streaming" to begin</p>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
        {!isStreaming ? (
          <>
            <button
              onClick={startStreaming}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                cursor: 'pointer',
                backgroundColor: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '4px'
              }}
            >
              Start Streaming ({streamType})
            </button>
            <button
              onClick={switchStream}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                cursor: 'pointer',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px'
              }}
            >
              Switch to {streamType === 'camera' ? 'Screen Share' : 'Camera'}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={stopStreaming}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                cursor: 'pointer',
                backgroundColor: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '4px'
              }}
            >
              Stop Streaming
            </button>
            <button
              onClick={switchStream}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1rem',
                cursor: 'pointer',
                backgroundColor: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px'
              }}
            >
              Switch to {streamType === 'camera' ? 'Screen Share' : 'Camera'}
            </button>
          </>
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
        <p><strong>Status:</strong> {isStreaming ? '🟢 Streaming' : '⚪ Not Streaming'}</p>
      </div>
    </div>
  );
}









import { io, Socket } from 'socket.io-client';

export type StreamType = 'camera' | 'screen';

export interface WebRTCConfig {
  signalingServerUrl: string;
  roomId: string;
  userId: string;
  userType: 'broadcaster' | 'viewer';
}

export class WebRTCManager {
  private socket: Socket | null = null;
  private localStream: MediaStream | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private config: WebRTCConfig;
  private onRemoteStream?: (stream: MediaStream, userId: string) => void;
  private onUserJoined?: (userId: string) => void;
  private onUserLeft?: (userId: string) => void;

  constructor(config: WebRTCConfig) {
    this.config = config;
  }

  async initialize(
    onRemoteStream?: (stream: MediaStream, userId: string) => void,
    onUserJoined?: (userId: string) => void,
    onUserLeft?: (userId: string) => void
  ) {
    this.onRemoteStream = onRemoteStream;
    this.onUserJoined = onUserJoined;
    this.onUserLeft = onUserLeft;

    // Connect to signaling server
    this.socket = io(this.config.signalingServerUrl, {
      transports: ['websocket'],
    });

    this.setupSocketListeners();
    
    // Join room
    this.socket.emit('join-room', {
      roomId: this.config.roomId,
      userId: this.config.userId,
      userType: this.config.userType,
    });
  }

  private setupSocketListeners() {
    if (!this.socket) return;

    this.socket.on('user-joined', async ({ userId, userType }) => {
      console.log(`User joined: ${userId} (${userType})`);
      this.onUserJoined?.(userId);

      if (this.config.userType === 'broadcaster' && userType === 'viewer') {
        await this.createOffer(userId);
      } else if (this.config.userType === 'viewer' && userType === 'broadcaster') {
        // Viewer will receive offer from broadcaster
      }
    });

    this.socket.on('room-users', (users: Array<{ userId: string; userType: string }>) => {
      console.log('Room users:', users);
      users.forEach(({ userId, userType }) => {
        if (this.config.userType === 'broadcaster' && userType === 'viewer') {
          this.createOffer(userId);
        }
      });
    });

    this.socket.on('offer', async ({ offer, senderId }) => {
      console.log('Received offer from:', senderId);
      await this.handleOffer(offer, senderId);
    });

    this.socket.on('answer', async ({ answer, senderId }) => {
      console.log('Received answer from:', senderId);
      await this.handleAnswer(answer, senderId);
    });

    this.socket.on('ice-candidate', async ({ candidate, senderId }) => {
      console.log('Received ICE candidate from:', senderId);
      await this.handleIceCandidate(candidate, senderId);
    });

    this.socket.on('user-left', ({ userId }) => {
      console.log('User left:', userId);
      this.closePeerConnection(userId);
      this.onUserLeft?.(userId);
    });
  }

  private createPeerConnection(userId: string): RTCPeerConnection {
    const configuration: RTCConfiguration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    };

    const pc = new RTCPeerConnection(configuration);

    // Add local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Handle remote stream
    pc.ontrack = (event) => {
      console.log('Received remote track from:', userId);
      if (event.streams[0]) {
        this.onRemoteStream?.(event.streams[0], userId);
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && this.socket) {
        this.socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetUserId: userId,
          roomId: this.config.roomId,
        });
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${userId}:`, pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        this.closePeerConnection(userId);
      }
    };

    this.peerConnections.set(userId, pc);
    return pc;
  }

  private async createOffer(userId: string) {
    const pc = this.createPeerConnection(userId);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (this.socket) {
        this.socket.emit('offer', {
          offer,
          targetUserId: userId,
          roomId: this.config.roomId,
        });
      }
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit, senderId: string) {
    const pc = this.createPeerConnection(senderId);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (this.socket) {
        this.socket.emit('answer', {
          answer,
          targetUserId: senderId,
          roomId: this.config.roomId,
        });
      }
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit, senderId: string) {
    const pc = this.peerConnections.get(senderId);
    if (!pc) return;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit, senderId: string) {
    const pc = this.peerConnections.get(senderId);
    if (!pc) return;

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error handling ICE candidate:', error);
    }
  }

  async startStream(streamType: StreamType = 'camera') {
    try {
      if (streamType === 'camera') {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 1280, height: 720 },
          audio: true,
        });
      } else {
        this.localStream = await navigator.mediaDevices.getDisplayMedia({
          video: { width: 1280, height: 720 },
          audio: true,
        });
      }

      // Update all existing peer connections with new stream
      this.peerConnections.forEach((pc) => {
        this.localStream!.getTracks().forEach((track) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
          if (sender) {
            sender.replaceTrack(track);
          } else {
            pc.addTrack(track, this.localStream!);
          }
        });
      });

      if (this.socket) {
        this.socket.emit('stream-type', {
          streamType,
          roomId: this.config.roomId,
        });
      }

      return this.localStream;
    } catch (error) {
      console.error('Error starting stream:', error);
      throw error;
    }
  }

  async stopStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
      this.localStream = null;
    }
  }

  switchStreamType(streamType: StreamType) {
    this.stopStream();
    return this.startStream(streamType);
  }

  private closePeerConnection(userId: string) {
    const pc = this.peerConnections.get(userId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(userId);
    }
  }

  disconnect() {
    // Stop local stream
    this.stopStream();

    // Close all peer connections
    this.peerConnections.forEach((pc) => pc.close());
    this.peerConnections.clear();

    // Leave room and disconnect socket
    if (this.socket) {
      this.socket.emit('leave-room', { roomId: this.config.roomId });
      this.socket.disconnect();
      this.socket = null;
    }
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }
}









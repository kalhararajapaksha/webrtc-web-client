import { io, Socket } from 'socket.io-client';

export type StreamType = 'camera' | 'screen';

export interface WebRTCConfig {
  signalingServerUrl: string;
  roomId: string;
  userId: string;
  userType: 'broadcaster' | 'viewer';
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface ConnectionState {
  retryCount: number;
  lastRetryTime: number;
  isRetrying: boolean;
}

export class WebRTCManager {
  private socket: Socket | null = null;
  private localStream: MediaStream | null = null;
  private peerConnections: Map<string, RTCPeerConnection> = new Map();
  private iceCandidateQueues: Map<string, RTCIceCandidateInit[]> = new Map();
  private connectionStates: Map<string, ConnectionState> = new Map();
  private config: WebRTCConfig;
  private onRemoteStream?: (stream: MediaStream, userId: string) => void;
  private onUserJoined?: (userId: string) => void;
  private onUserLeft?: (userId: string) => void;
  private readonly MAX_RETRY_ATTEMPTS = 5; // Increased from 3 to 5 for better recovery
  private readonly RETRY_DELAY_BASE = 1000; // 1 second base delay

  constructor(config: WebRTCConfig) {
    this.config = config;
  }

  private getIceServers(): IceServerConfig[] {
    const iceServers: IceServerConfig[] = [
      // STUN servers for NAT discovery
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // Add TURN servers from environment variables
    const turnServerUrl = process.env.NEXT_PUBLIC_TURN_SERVER_URL;
    const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME;
    const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;

    if (turnServerUrl) {
      // Support multiple TURN servers (comma-separated)
      const turnUrls = turnServerUrl.split(',').map(url => url.trim());
      
      turnUrls.forEach(url => {
        if (url.startsWith('turn:') || url.startsWith('turns:')) {
          iceServers.push({
            urls: url,
            username: turnUsername || undefined,
            credential: turnCredential || undefined,
          });
        } else {
          // Auto-detect protocol and add both UDP and TCP
          const host = url.replace(/^(turn|turns):\/\//, '');
          iceServers.push(
            {
              urls: `turn:${host}?transport=udp`,
              username: turnUsername || undefined,
              credential: turnCredential || undefined,
            },
            {
              urls: `turn:${host}?transport=tcp`,
              username: turnUsername || undefined,
              credential: turnCredential || undefined,
            }
          );
        }
      });
    }

    return iceServers;
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

    // Listen for peer connection state changes (from viewer to broadcaster)
    this.socket.on('peer-connection-state', ({ userId, targetUserId, connectionState, iceConnectionState }) => {
      // If we're a broadcaster and a viewer (userId) reports connection failure to us (targetUserId is us)
      // Or if we're a viewer and broadcaster reports state (for logging purposes)
      if (this.config.userType === 'broadcaster' && targetUserId === this.config.userId) {
        // A viewer (userId) is reporting their connection state to us (broadcaster)
        console.log(`📢 Viewer ${userId} reports connection state: ${connectionState} (ICE: ${iceConnectionState})`);
        
        if (connectionState === 'failed' || iceConnectionState === 'failed' || 
            connectionState === 'disconnected' || iceConnectionState === 'disconnected') {
          console.log(`🔄 Broadcaster initiating ICE restart for failed viewer connection: ${userId}`);
          // Directly restart ICE as broadcaster when viewer reports failure
          this.restartIceForPeer(userId);
        }
      }
    });
  }

  private async restartIceForPeer(userId: string) {
    // This is called when broadcaster detects viewer failure
    const pc = this.peerConnections.get(userId);
    if (!pc) {
      console.warn(`No peer connection found for ${userId}, creating new offer...`);
      // Create new offer if connection doesn't exist
      await this.createOffer(userId);
      return;
    }

    // Check if we should retry
    const state = this.connectionStates.get(userId);
    if (state && state.retryCount >= this.MAX_RETRY_ATTEMPTS) {
      console.error(`❌ Max retry attempts reached for ${userId}, skipping ICE restart`);
      return;
    }

    if (state) {
      state.retryCount++;
      state.lastRetryTime = Date.now();
    }

    try {
      console.log(`🔄 Broadcaster creating ICE restart offer for viewer ${userId}`);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering
      await this.waitForIceGathering(pc, 5000);

      if (this.socket) {
        this.socket.emit('offer', {
          offer: pc.localDescription,
          targetUserId: userId,
          roomId: this.config.roomId,
        });
        console.log(`📤 Sent ICE restart offer to viewer ${userId}`);
      }
    } catch (error) {
      console.error(`Error creating ICE restart offer for viewer ${userId}:`, error);
    }
  }

  private createPeerConnection(userId: string): RTCPeerConnection {
    const configuration: RTCConfiguration = {
      iceServers: this.getIceServers(),
      iceCandidatePoolSize: 10, // Pre-gather candidates for faster connection
    };

    const pc = new RTCPeerConnection(configuration);

    // Initialize connection state
    this.connectionStates.set(userId, {
      retryCount: 0,
      lastRetryTime: 0,
      isRetrying: false,
    });

    // Initialize ICE candidate queue
    this.iceCandidateQueues.set(userId, []);

    // Add local stream tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    // Handle remote stream
    pc.ontrack = (event) => {
      console.log('✅ Received remote track from:', userId);
      if (event.streams[0]) {
        this.onRemoteStream?.(event.streams[0], userId);
      }
    };

    // Handle ICE candidates with proper logging
    pc.onicecandidate = (event) => {
      if (event.candidate && this.socket) {
        // Parse ICE candidate type for diagnostics
        const candidateStr = event.candidate.candidate;
        let candidateType = 'unknown';
        let protocol = 'unknown';
        
        // Extract candidate type (host, srflx, relay, prflx)
        const typeMatch = candidateStr.match(/typ (\w+)/);
        if (typeMatch) {
          candidateType = typeMatch[1];
        }
        
        // Extract protocol
        if (candidateStr.includes(' UDP ')) {
          protocol = 'UDP';
        } else if (candidateStr.includes(' TCP ')) {
          protocol = 'TCP';
        }
        
        // Log candidate type for diagnostics
        const typeEmoji = candidateType === 'relay' ? '🔄' : candidateType === 'srflx' ? '🌐' : '🏠';
        console.log(`📡 ICE candidate gathered for ${userId}: ${typeEmoji} ${candidateType}/${protocol} - ${candidateStr.substring(0, 60)}...`);
        
        // Warn if no relay candidates (needed for cross-network)
        if (candidateType === 'relay') {
          console.log(`✅ TURN server working! Relay candidate found for ${userId}`);
        }
        
        this.socket.emit('ice-candidate', {
          candidate: event.candidate,
          targetUserId: userId,
          roomId: this.config.roomId,
        });
      } else if (!event.candidate) {
        console.log(`✅ ICE gathering completed for ${userId}`);
        
        // Check if we have relay candidates (critical for cross-network)
        const stats = pc.getStats();
        stats.then(statReport => {
          let hasRelay = false;
          statReport.forEach((report) => {
            if (report.type === 'local-candidate' && report.candidateType === 'relay') {
              hasRelay = true;
            }
          });
          
          if (!hasRelay && this.peerConnections.size > 0) {
            console.warn(`⚠️ No relay candidates found for ${userId}. Cross-network connectivity may fail. Consider configuring TURN server.`);
          }
        });
      }
    };

    // Handle ICE gathering state changes
    pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state for ${userId}:`, pc.iceGatheringState);
    };

    // Handle ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log(`ICE connection state for ${userId}:`, pc.iceConnectionState);
      
      // Notify the other peer about connection state changes (for broadcaster to detect viewer failures)
      if (this.socket && (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || 
                          pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
        this.socket.emit('peer-connection-state', {
          userId: this.config.userId,
          targetUserId: userId,
          roomId: this.config.roomId,
          connectionState: pc.iceConnectionState,
          iceConnectionState: pc.iceConnectionState,
        });
      }
      
      if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
        console.warn(`⚠️ ICE connection ${pc.iceConnectionState} for ${userId}, attempting recovery...`);
        this.handleConnectionFailure(userId);
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log(`✅ ICE connection ${pc.iceConnectionState} for ${userId}`);
        // Reset retry count on successful connection
        const state = this.connectionStates.get(userId);
        if (state) {
          state.retryCount = 0;
          state.isRetrying = false;
        }
      }
    };

    // Handle connection state changes with recovery
    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${userId}:`, pc.connectionState);
      
      // Notify the other peer about connection state changes (for broadcaster to detect viewer failures)
      if (this.socket) {
        this.socket.emit('peer-connection-state', {
          userId: this.config.userId,
          targetUserId: userId,
          roomId: this.config.roomId,
          connectionState: pc.connectionState,
          iceConnectionState: pc.iceConnectionState,
        });
      }
      
      if (pc.connectionState === 'failed') {
        console.error(`❌ Connection failed for ${userId}, attempting recovery...`);
        this.handleConnectionFailure(userId);
      } else if (pc.connectionState === 'disconnected') {
        console.warn(`⚠️ Connection disconnected for ${userId}`);
        // Also try recovery on disconnected state
        if (this.config.userType === 'broadcaster') {
          // Broadcaster should attempt recovery for disconnected viewers
          this.handleConnectionFailure(userId);
        }
      } else if (pc.connectionState === 'connected') {
        console.log(`✅ Connection established with ${userId}`);
        // Reset retry count on successful connection
        const state = this.connectionStates.get(userId);
        if (state) {
          state.retryCount = 0;
          state.isRetrying = false;
        }
      }
    };

    this.peerConnections.set(userId, pc);
    return pc;
  }

  private async handleConnectionFailure(userId: string) {
    const state = this.connectionStates.get(userId);
    if (!state) return;

    // Prevent multiple simultaneous retry attempts
    if (state.isRetrying) {
      console.log(`Retry already in progress for ${userId}`);
      return;
    }

    // Check if we've exceeded max retry attempts
    if (state.retryCount >= this.MAX_RETRY_ATTEMPTS) {
      console.error(`❌ Max retry attempts reached for ${userId}`);
      return;
    }

    state.isRetrying = true;
    state.retryCount++;
    
    // Exponential backoff: 1s, 2s, 4s
    const delay = this.RETRY_DELAY_BASE * Math.pow(2, state.retryCount - 1);
    const timeSinceLastRetry = Date.now() - state.lastRetryTime;
    
    if (timeSinceLastRetry < delay) {
      await new Promise(resolve => setTimeout(resolve, delay - timeSinceLastRetry));
    }

    state.lastRetryTime = Date.now();

    console.log(`🔄 Attempting ICE restart for ${userId} (attempt ${state.retryCount}/${this.MAX_RETRY_ATTEMPTS})`);
    
    try {
      await this.restartIce(userId);
    } catch (error) {
      console.error(`Error restarting ICE for ${userId}:`, error);
    } finally {
      state.isRetrying = false;
    }
  }

  private async restartIce(userId: string) {
    const pc = this.peerConnections.get(userId);
    if (!pc) return;

    // Create new offer to restart ICE
    try {
      if (this.config.userType === 'broadcaster') {
        // Broadcaster creates new offer
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);

        if (this.socket) {
          this.socket.emit('offer', {
            offer,
            targetUserId: userId,
            roomId: this.config.roomId,
          });
        }
      } else {
        // Viewer waits for new offer from broadcaster
        console.log(`Waiting for ICE restart offer from broadcaster ${userId}`);
      }
    } catch (error) {
      console.error(`Error creating ICE restart offer for ${userId}:`, error);
      throw error;
    }
  }

  private async waitForIceGathering(pc: RTCPeerConnection, timeout = 5000): Promise<void> {
    if (pc.iceGatheringState === 'complete') {
      return;
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        console.warn('⚠️ ICE gathering timeout, proceeding anyway');
        resolve();
      }, timeout);

      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeoutId);
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', checkState);
      
      // Check immediately in case it's already complete
      checkState();
    });
  }

  private async flushIceCandidateQueue(userId: string) {
    const pc = this.peerConnections.get(userId);
    const queue = this.iceCandidateQueues.get(userId);
    
    if (!pc || !queue || queue.length === 0) return;

    console.log(`📥 Flushing ${queue.length} queued ICE candidates for ${userId}`);
    
    // Wait for remote description to be set
    if (pc.remoteDescription) {
      for (const candidate of queue) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
          console.error(`Error adding queued ICE candidate for ${userId}:`, error);
        }
      }
      // Clear the queue
      this.iceCandidateQueues.set(userId, []);
    }
  }

  private async createOffer(userId: string) {
    const pc = this.createPeerConnection(userId);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete (with timeout)
      await this.waitForIceGathering(pc, 5000);

      if (this.socket) {
        this.socket.emit('offer', {
          offer: pc.localDescription,
          targetUserId: userId,
          roomId: this.config.roomId,
        });
        console.log(`📤 Sent offer to ${userId}`);
      }
    } catch (error) {
      console.error('Error creating offer:', error);
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit, senderId: string) {
    // Check if this is an ICE restart (renegotiation)
    const existingPc = this.peerConnections.get(senderId);
    const pc = existingPc || this.createPeerConnection(senderId);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Flush any queued ICE candidates now that remote description is set
      await this.flushIceCandidateQueue(senderId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      // Wait for ICE gathering to complete (with timeout)
      await this.waitForIceGathering(pc, 5000);

      if (this.socket) {
        this.socket.emit('answer', {
          answer: pc.localDescription,
          targetUserId: senderId,
          roomId: this.config.roomId,
        });
        console.log(`📤 Sent answer to ${senderId}`);
      }
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit, senderId: string) {
    const pc = this.peerConnections.get(senderId);
    if (!pc) {
      console.warn(`No peer connection found for ${senderId} when handling answer`);
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      
      // Flush any queued ICE candidates now that remote description is set
      await this.flushIceCandidateQueue(senderId);
      
      console.log(`✅ Set remote description (answer) from ${senderId}`);
    } catch (error) {
      console.error('Error handling answer:', error);
    }
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit, senderId: string) {
    const pc = this.peerConnections.get(senderId);
    
    if (!pc) {
      console.warn(`No peer connection found for ${senderId} when handling ICE candidate, queueing...`);
      // Queue the candidate for later
      const queue = this.iceCandidateQueues.get(senderId) || [];
      queue.push(candidate);
      this.iceCandidateQueues.set(senderId, queue);
      return;
    }

    try {
      // If remote description is not set yet, queue the candidate
      if (!pc.remoteDescription) {
        console.log(`Remote description not set for ${senderId}, queueing ICE candidate...`);
        const queue = this.iceCandidateQueues.get(senderId) || [];
        queue.push(candidate);
        this.iceCandidateQueues.set(senderId, queue);
        return;
      }

      // Add the candidate immediately
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      console.log(`✅ Added ICE candidate for ${senderId}`);
    } catch (error) {
      // If adding candidate fails, queue it for later
      console.warn(`Error adding ICE candidate for ${senderId}, queueing:`, error);
      const queue = this.iceCandidateQueues.get(senderId) || [];
      queue.push(candidate);
      this.iceCandidateQueues.set(senderId, queue);
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
    // Clean up state
    this.iceCandidateQueues.delete(userId);
    this.connectionStates.delete(userId);
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









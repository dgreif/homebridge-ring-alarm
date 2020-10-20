import { ReplaySubject, timer } from 'rxjs'
import {
  createStunResponder,
  isStunMessage,
  RtpDescription,
  RtpOptions,
  sendStunBindingRequest,
} from './rtp-utils'
import {
  createCryptoLine,
  FfmpegProcess,
  reservePorts,
  releasePorts,
  RtpSplitter,
} from '@homebridge/camera-utils'
import { expiredDingError, SipCall, SipOptions } from './sip-call'
import { RingCamera } from './ring-camera'
import { RtpLatchGenerator } from './rtp-latch-generator'
import { Subscribed } from './subscribed'
import { logDebug, logError } from './util'
import { getFfmpegPath } from './ffmpeg'
import { takeUntil } from 'rxjs/operators'
const stun = require('stun')

type SpawnInput = string | number
export interface FfmpegOptions {
  input?: SpawnInput[]
  video?: SpawnInput[] | false
  audio?: SpawnInput[]
  output: SpawnInput[]
  quickStart?: boolean
}

export class SipSession extends Subscribed {
  private hasStarted = false
  private hasCallEnded = false
  private onCallEndedSubject = new ReplaySubject(1)
  private sipCall: SipCall = this.createSipCall(this.sipOptions)
  public readonly reservedPorts = [
    this.tlsPort,
    this.rtpOptions.video.port,
    this.rtpOptions.audio.port,
  ]
  onCallEnded = this.onCallEndedSubject.asObservable()

  constructor(
    public readonly sipOptions: SipOptions,
    public readonly rtpOptions: RtpOptions,
    public readonly audioSplitter: RtpSplitter,
    public readonly audioRtcpSplitter: RtpSplitter,
    public readonly videoSplitter: RtpSplitter,
    public readonly videoRtcpSplitter: RtpSplitter,
    private readonly tlsPort: number,
    public readonly camera: RingCamera
  ) {
    super()
  }

  createSipCall(sipOptions: SipOptions) {
    if (this.sipCall) {
      this.sipCall.destroy()
    }

    const call = (this.sipCall = new SipCall(
      sipOptions,
      this.rtpOptions,
      this.tlsPort
    ))

    this.addSubscriptions(
      call.onEndedByRemote.subscribe(() => this.callEnded(false))
    )

    return this.sipCall
  }

  async start(ffmpegOptions?: FfmpegOptions): Promise<RtpDescription> {
    if (this.hasStarted) {
      throw new Error('SIP Session has already been started')
    }
    this.hasStarted = true

    if (this.hasCallEnded) {
      throw new Error('SIP Session has already ended')
    }

    try {
      const videoPort = await this.reservePort(1),
        audioPort = await this.reservePort(1),
        rtpDescription = await this.sipCall.invite()

      if (ffmpegOptions) {
        this.startTranscoder(
          ffmpegOptions,
          rtpDescription,
          audioPort,
          videoPort
        )
      }

      if (rtpDescription.video.iceUFrag) {
        // ICE is supported
        createStunResponder(this.videoSplitter)
        createStunResponder(this.audioSplitter)

        sendStunBindingRequest({
          rtpSplitter: this.videoSplitter,
          rtpDescription,
          localUfrag: this.sipCall.videoUfrag,
          type: 'video',
        })

        sendStunBindingRequest({
          rtpSplitter: this.audioSplitter,
          rtpDescription,
          localUfrag: this.sipCall.audioUfrag,
          type: 'audio',
        })
      } else {
        // ICE is not supported, use RTP latching
        const { address } = rtpDescription,
          remoteAudioLocation = {
            port: rtpDescription.audio.port,
            address,
          },
          remoteAudioRtcpLocation = {
            port: rtpDescription.audio.rtcpPort,
            address,
          },
          remoteVideoLocation = {
            port: rtpDescription.video.port,
            address,
          },
          remoteVideoRtcpLocation = {
            port: rtpDescription.video.rtcpPort,
            address,
          },
          sendKeepAlive = () => {
            const audioStun = stun.encode(stun.createMessage(1)),
              videoStun = stun.encode(stun.createMessage(1))

            this.audioSplitter.send(audioStun, remoteAudioLocation)
            this.audioSplitter.send(audioStun, remoteAudioRtcpLocation)

            this.videoSplitter.send(videoStun, remoteVideoLocation)
            this.videoSplitter.send(videoStun, remoteVideoRtcpLocation)
          },
          audioLatchGenerator = new RtpLatchGenerator(this.rtpOptions.audio, 0),
          videoLatchGenerator = new RtpLatchGenerator(this.rtpOptions.video, 99)

        this.addSubscriptions(
          // hole punch every .5 seconds to keep stream alive and port open (matches behavior from Ring app)
          timer(0, 500).subscribe(sendKeepAlive),

          // Send a valid RTP packet to audio/video ports repeatedly until data is received.
          // This is how Ring gets through NATs.  See https://tools.ietf.org/html/rfc7362 for details
          audioLatchGenerator.onLatchPacket
            .pipe(takeUntil(this.audioSplitter.onMessage))
            .subscribe((latchPacket) => {
              // console.log('AUDIO', latchPacket.toString('hex'))
              this.audioSplitter.send(latchPacket, remoteAudioLocation)
            }),
          videoLatchGenerator.onLatchPacket
            .pipe(takeUntil(this.videoSplitter.onMessage))
            .subscribe((latchPacket) => {
              // console.log('VIDEO', latchPacket.toString('hex'))
              this.videoSplitter.send(latchPacket, remoteVideoLocation)
            })
        )
      }

      return rtpDescription
    } catch (e) {
      if (e === expiredDingError) {
        const sipOptions = await this.camera.getUpdatedSipOptions(
          this.sipOptions.dingId
        )
        this.createSipCall(sipOptions)
        this.hasStarted = false
        return this.start(ffmpegOptions)
      }

      this.callEnded(true)
      throw e
    }
  }

  private startTranscoder(
    ffmpegOptions: FfmpegOptions,
    remoteRtpOptions: RtpOptions,
    audioPort: number,
    videoPort: number
  ) {
    const transcodeVideoStream = ffmpegOptions.video !== false,
      quickStart = ffmpegOptions.quickStart === true,
      ffmpegArgs = [
        '-hide_banner',
        '-protocol_whitelist',
        'pipe,udp,rtp,file,crypto',
        '-f',
        'sdp',
        ...(quickStart
          ? [
            '-probesize', '32', 
            '-analyzeduration', '1000', 
            '-r', '15', 
            '-fflags', 'nobuffer',
            '-flags', 'low_delay']
          : []),
        ...(ffmpegOptions.input || []),
        '-i',
        'pipe:',
        ...(ffmpegOptions.audio || ['-acodec', 'aac']),
        ...(transcodeVideoStream && !quickStart
          ? ffmpegOptions.video || ['-vcodec', 'copy']
          : []),
        ...(ffmpegOptions.output || []),
      ],
      ff = new FfmpegProcess({
        ffmpegArgs,
        ffmpegPath: getFfmpegPath(),
        exitCallback: () => this.callEnded(true),
        logLabel: `From Ring (${this.camera.name})`,
        logger: {
          error: logError,
          info: logDebug,
        },
      }),
      inputSdpLines = [
        'v=0',
        'o=105202070 3747 461 IN IP4 127.0.0.1',
        's=Talk',
        'c=IN IP4 127.0.0.1',
        'b=AS:380',
        't=0 0',
        'a=rtcp-xr:rcvr-rtt=all:10000 stat-summary=loss,dup,jitt,TTL voip-metrics',
        `m=audio ${audioPort} RTP/SAVP 0 101`,
        'a=rtpmap:0 PCMU/8000',
        createCryptoLine(remoteRtpOptions.audio),
        'a=rtcp-mux',
      ]

    if (transcodeVideoStream) {
      inputSdpLines.push(
        `m=video ${videoPort} RTP/SAVP 99`,
        'a=rtpmap:99 H264/90000',
        ...(quickStart ? ['a=framesize:99 1920-1080'] : []),
        createCryptoLine(remoteRtpOptions.video),
        'a=rtcp-mux'
      )

      let haveReceivedStreamPacket = false
      this.videoSplitter.addMessageHandler(({ isRtpMessage, message }) => {
        if (isStunMessage(message)) {
          return null
        }

        if (!haveReceivedStreamPacket) {
          void this.sipCall.requestKeyFrame()
          haveReceivedStreamPacket = true
        }

        return {
          port: isRtpMessage ? videoPort : videoPort + 1,
        }
      })
    }

    this.onCallEnded.subscribe(() => ff.stop())

    ff.writeStdin(inputSdpLines.filter((x) => Boolean(x)).join('\n'))

    this.audioSplitter.addMessageHandler(({ isRtpMessage, message }) => {
      if (isStunMessage(message)) {
        return null
      }

      return {
        port: isRtpMessage ? audioPort : audioPort + 1,
      }
    })
  }

  async reservePort(bufferPorts = 0) {
    const ports = await reservePorts({ count: bufferPorts + 1 })
    this.reservedPorts.push(...ports)
    return ports[0]
  }

  requestKeyFrame() {
    return this.sipCall.requestKeyFrame()
  }

  activateCameraSpeaker() {
    return this.sipCall.activateCameraSpeaker()
  }

  private callEnded(sendBye: boolean) {
    if (this.hasCallEnded) {
      return
    }
    this.hasCallEnded = true

    if (sendBye) {
      this.sipCall.sendBye()
    }

    // clean up
    this.onCallEndedSubject.next()
    this.sipCall.destroy()
    this.videoSplitter.close()
    this.audioSplitter.close()
    this.unsubscribe()
    releasePorts(this.reservedPorts)
  }

  stop() {
    this.callEnded(true)
  }
}

import { logDebug, logError } from './util'
import { RtpSplitter, SrtpOptions } from '@homebridge/camera-utils'
const stun = require('stun')

const stunMagicCookie = 0x2112a442 // https://tools.ietf.org/html/rfc5389#section-6

export interface RtpStreamOptions extends SrtpOptions {
  port: number
  rtcpPort: number
}

export interface RtpOptions {
  audio: RtpStreamOptions
  video: RtpStreamOptions
}

export interface RtpStreamDescription extends RtpStreamOptions {
  ssrc?: number
  iceUFrag?: string
  icePwd?: string
}

export interface RtpDescription {
  address: string
  audio: RtpStreamDescription
  video: RtpStreamDescription
}

export function isStunMessage(message: Buffer) {
  return message.length > 8 && message.readInt32BE(4) === stunMagicCookie
}

export function sendStunBindingRequest({
  rtpDescription,
  rtpSplitter,
  localUfrag,
  type,
}: {
  rtpSplitter: RtpSplitter
  rtpDescription: RtpDescription
  localUfrag: string
  type: 'video' | 'audio'
}) {
  const message = stun.createMessage(1),
    remoteDescription = rtpDescription[type]

  message.addUsername(remoteDescription.iceUFrag + ':' + localUfrag)
  message.addMessageIntegrity(remoteDescription.icePwd)
  stun
    .request(`${rtpDescription.address}:${remoteDescription.port}`, {
      socket: rtpSplitter.socket,
      message,
    })
    .then(() => logDebug(`${type} stun complete`))
    .catch((e: Error) => {
      logError(`${type} stun error`)
      logError(e)
    })
}

export function createStunResponder(rtpSplitter: RtpSplitter) {
  return rtpSplitter.addMessageHandler(({ message, info }) => {
    if (!isStunMessage(message)) {
      return null
    }

    try {
      const decodedMessage = stun.decode(message),
        response = stun.createMessage(
          stun.constants.STUN_BINDING_RESPONSE,
          decodedMessage.transactionId
        )

      response.addXorAddress(info.address, info.port)
      rtpSplitter.send(stun.encode(response), info).catch(logError)
    } catch (e) {
      logDebug('Failed to Decode STUN Message')
      logDebug(message.toString('hex'))
      logDebug(e)
    }

    return null
  })
}

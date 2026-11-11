// SPDX-License-Identifier: LGPL-3.0-or-later
// @seikou/nas: the wire contract shared by Seikou's NAS server, the app and the rendezvous Worker.
// Everything else is internal, reached through ./*.

// The API's request and response types that the integration guide and the other packages' signatures use.
export type {
  DiscManifest,
  TitleSummary,
  TitleNames,
  TitleKind,
  TitleDetail,
  TitleMusic,
  MusicKind,
  SeasonDetail,
  DiscSlot,
  DiscRef,
  EpisodeRef,
  UnsortedItem,
  UnsortedReason,
  UnsortedSuggestion,
  OwnerChoice,
  OwnTitle,
  PlaybackPlace,
  PlaceSettings,
  PlaceTextFile,
  PlaceFansub,
  PlaceSubtitleSource,
  ContinueItem,
  PlaylistProgress,
  EncodeShow,
  EncodeSeason,
  EncodeEpisode,
  StoredSubtitle,
  SubtitleAttachment,
  FansubPick,
  FansubSource,
  FansubAlignment,
  SeaDexRank,
} from './nas-api';
// Disc keys.
export { discKeyOf, parseDiscKey, type ParsedDiscKey } from './disc-key';
// TheDiscDB's ContentHash.
export { contentHash } from './content-hash';
// Rules for saved places the server and the app share.
export { isShortPlace } from './place-rules';
// Place keys of either library.
export { parsePlaceKey, type ParsedPlaceKey } from './place-key';
// The title an encoded episode belongs to, read from and written to its tags.
export { type EncodeTitle, titleFromTags, titleTags } from './encode-title';
// Encode ids and encode place keys.
export { encodeId, parseEncodeId, encodePlaceKey } from './encode-id';
// Title normalisation and matching.
export { normalizeTitle, titleMatches } from './title-text';
// Pairing codes.
export { normalizeCode, formatCode } from './pairing-code';
// The CORS rules the server and the Worker share.
export { corsHeaders } from './cors-policy';
// HTTP-shaped requests and responses over one WebRTC data channel.
export { WireClient, WireServer, type WireChannel, type WireRequest, type WireResponse } from './rtc-wire';

"""Compatibility facade for the typed playable-media capability.

Provider orchestration lives in :mod:`relay.media_providers`; parsers and
canonical URL handling live in :mod:`relay.media_core`. Existing imports keep
working while new providers register through the shared capability pipeline.
"""
from relay.media_core import (
    _supported_result, _twitch_target, _youtube_id, _youtube_channel_id,
    _video_subject, _verify_twitch_channel, parse_bing_videos,
    parse_media_request, parse_youtube_feed, parse_youtube_search, VideosFailed,
)
from relay.media_providers import (
    TwitchLiveAdapter, engine_videos, register_media_adapter, _twitch_live_row,
)

__all__ = ["engine_videos", "register_media_adapter", "TwitchLiveAdapter",
           "parse_bing_videos", "parse_media_request", "parse_youtube_feed",
           "parse_youtube_search"]

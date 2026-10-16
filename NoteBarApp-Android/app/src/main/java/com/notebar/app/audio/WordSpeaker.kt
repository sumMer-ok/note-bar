package com.notebar.app.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.speech.tts.TextToSpeech
import com.notebar.app.domain.TtsUrl
import java.util.Locale

/**
 * 单词发音。对应 iOS `Speaker`：
 * - 优先用设置里的 TTS 模板拼出远程音频 URL 并播放（有道词典音源）；
 * - 远程失败 / 模板为空 / 播放异常时，降级到系统离线 TTS（`en-US`）。
 *
 * 与 iOS 的差异：iOS 用 `AVSpeechSynthesizer` 兜底，Android 用 `TextToSpeech`；
 * 远程播放 iOS 是「先下载校验非空再播」，Android 的 MediaPlayer 同样在
 * `onPrepared` 里才开始播放，等价于先校验可解码。
 */
class WordSpeaker(private val context: Context) {

    private var player: MediaPlayer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    private fun ensureTts() {
        if (tts != null) return
        tts = TextToSpeech(context) { status ->
            ttsReady = status == TextToSpeech.SUCCESS
            if (ttsReady) tts?.setLanguage(Locale.US)
        }
    }

    /**
     * 朗读一个单词。
     *
     * @param template 设置里的 TTS 模板（`{{word}}` / `{{type}}` / `{{accent}}` 占位符）
     */
    fun speak(word: String, template: String) {
        val url = runCatching { TtsUrl.build(template, word, us = true) }.getOrNull()
        if (url.isNullOrBlank()) {
            fallback(word)
            return
        }
        try {
            releasePlayer()
            val mp = MediaPlayer()
            player = mp
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            mp.setDataSource(url)
            mp.setOnPreparedListener { it.start() }
            mp.setOnErrorListener { _, _, _ ->
                fallback(word)
                releasePlayer()
                true
            }
            mp.prepareAsync()
        } catch (_: Exception) {
            fallback(word)
        }
    }

    /** 系统离线语音兜底 */
    fun fallback(word: String) {
        ensureTts()
        val engine = tts ?: return
        // 语音引擎尚未就绪时 speak 会静默失败，这里显式判断一次可用性
        val available = runCatching { engine.isLanguageAvailable(Locale.US) }.getOrDefault(-1)
        if (available < 0) return
        engine.speak(word, TextToSpeech.QUEUE_FLUSH, null, "notebar-$word")
    }

    private fun releasePlayer() {
        player?.let {
            runCatching { it.reset() }
            runCatching { it.release() }
        }
        player = null
    }

    /** 页面退出 / ViewModel 清理时调用 */
    fun shutdown() {
        releasePlayer()
        tts?.let {
            runCatching { it.stop() }
            runCatching { it.shutdown() }
        }
        tts = null
        ttsReady = false
    }
}

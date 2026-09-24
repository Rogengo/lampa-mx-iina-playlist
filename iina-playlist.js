/**
 * IINA Playlist Plugin для Lampa (v7)
 * - Кнопка [m3u ⬇] встроена в .torrent-filter как обычная simple-button--filter
 * - Никаких кастомных инлайн-стилей на самой кнопке
 * - Скачивает M3U со всеми сериями
 */
(function () {
    'use strict';
    if (window.__iina_playlist_v7__) return;
    window.__iina_playlist_v7__ = true;

    var CONFIG = {
        EPISODE_DELAY:    1200,
        PLAYER_TIMEOUT:   15000,
        AFTER_START_WAIT: 800,
        POLL_INTERVAL:    400
    };

    var state = { collecting: false, cancelled: false, progressEl: null, pollTimer: null };

    function log() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift('[IINA]');
        try { console.log.apply(console, a); } catch (e) {}
    }
    function notify(msg) {
        try {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show(msg);
            else log('NOTY:', msg);
        } catch (e) {}
    }

    // ================== КНОПКА ==================
    function createButton() {
        // HTML полностью в стиле соседних кнопок. Класса filter--filter НЕТ —
        // чтобы не подцепить JS-поведение фильтра.
        var html =
            '<div class="simple-button simple-button--filter selector iina-btn">' +
                '<span>m3u Download</span>' +
                '</div>' +
            '</div>';

        var $btn = $(html);

        $btn.on('hover:enter click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            if (state.collecting) { notify('Уже выполняется'); return; }
            startCollection();
        });

        return $btn;
    }

    function removeButton() { $('.iina-btn').remove(); }

    function addButton() {
        var $container = $('.torrent-filter');
        if (!$container.length) return false;
        if ($container.find('.iina-btn').length) return true;
        $container.append(createButton());
        log('Кнопка добавлена в .torrent-filter');
        return true;
    }

    // ================== ПОЛЛИНГ ==================
    function startPolling() {
        stopPolling();
        addButton();
        state.pollTimer = setInterval(addButton, CONFIG.POLL_INTERVAL);
    }
    function stopPolling() {
        if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
    }

    // ================== ПРОГРЕСС ==================
    function showProgress(cur, total) {
        if (!state.progressEl) {
            state.progressEl = $(
                '<div style="position:fixed;bottom:2em;left:50%;transform:translateX(-50%);' +
                'background:rgba(0,0,0,.9);color:#fff;padding:.9em 1.8em;border-radius:.5em;' +
                'z-index:99999;font-size:1em;text-align:center;pointer-events:none;min-width:18em;' +
                'box-shadow:0 4px 20px rgba(0,0,0,.5);"></div>'
            );
            $('body').append(state.progressEl);
        }
        state.progressEl.html(
            'Сбор плейлиста: <b>' + cur + ' / ' + total + '</b>' +
            '<br><small style="opacity:.7">Backspace — отмена</small>'
        );
    }
    function hideProgress() {
        if (state.progressEl) { state.progressEl.remove(); state.progressEl = null; }
    }

    // ================== ХУК ПЛЕЕРА ==================
    function attachPlayerHook(onStream) {
        var captured = false, origPlay = null, attached = false;
        try {
            if (window.Lampa && Lampa.Player && typeof Lampa.Player.play === 'function') {
                origPlay = Lampa.Player.play;
                Lampa.Player.play = function (stream) {
                    if (!captured && stream) {
                        captured = true;
                        try { onStream(stream); } catch (e) { log('onStream err', e); }
                    }
                    return origPlay.apply(this, arguments);
                };
                attached = true;
            }
        } catch (e) { log('hook err', e); }
        return function () {
            if (attached && origPlay) {
                try { Lampa.Player.play = origPlay; } catch (e) {}
            }
        };
    }

    function extractUrl(stream) {
        if (!stream) return null;
        return stream.url || stream.stream_url || stream.file ||
               (stream.stream && stream.stream.url) || null;
    }

    function closePlayer() {
        try {
            if (window.Lampa && Lampa.Player) {
                if (typeof Lampa.Player.close === 'function') { Lampa.Player.close(); return; }
                if (typeof Lampa.Player.destroy === 'function') { Lampa.Player.destroy(); return; }
            }
            var ev = $.Event('keydown');
            ev.keyCode = 8; ev.which = 8;
            $(document).trigger(ev);
        } catch (e) {}
    }

    // ================== СБОР ==================
    function getEpisodes() {
        var list = [];
        $('.online__body').each(function () {
            var $b = $(this);
            var $t = $b.find('.online__title');
            list.push({
                title: $t.length ? $t.text().trim() : 'Серия',
                $trigger: $b.parent()
            });
        });
        return list;
    }

    function startCollection() {
        var eps = getEpisodes();
        if (!eps.length) { notify('Серии не найдены'); return; }
        state.collecting = true;
        state.cancelled = false;
        log('Сбор:', eps.length, 'серий');
        showProgress(0, eps.length);
        processNext(eps, 0, []);
    }

    function processNext(eps, i, collected) {
        if (state.cancelled) { finish(collected, 'Отменено'); return; }
        if (i >= eps.length) { finish(collected, null); return; }

        var ep = eps[i];
        showProgress(i + 1, eps.length);
        log('---', ep.title, '(' + (i + 1) + '/' + eps.length + ')');

        var detach = null, done = false;
        function complete() {
            if (done) return;
            done = true;
            if (detach) detach();
            closePlayer();
            setTimeout(function(){ processNext(eps, i + 1, collected); }, CONFIG.EPISODE_DELAY);
        }

        var tId = setTimeout(function () {
            log('Таймаут:', ep.title);
            complete();
        }, CONFIG.PLAYER_TIMEOUT);

        detach = attachPlayerHook(function (stream) {
            clearTimeout(tId);
            var url = extractUrl(stream);
            if (url && /^https?:/i.test(url)) {
                collected.push({ title: ep.title, url: url });
                log('✓', url);
            } else {
                log('✗ нет URL', stream);
            }
            setTimeout(complete, CONFIG.AFTER_START_WAIT);
        });

        try {
            ep.$trigger.trigger('hover:enter');
            ep.$trigger.trigger('click');
        } catch (e) {
            clearTimeout(tId);
            complete();
        }
    }

    // ================== ФИНАЛ ==================
    function finish(collected, reason) {
        state.collecting = false;
        state.cancelled = false;
        hideProgress();
        if (!collected.length) { notify('Ссылки не собраны'); return; }

        var m3u = '#EXTM3U\n';
        collected.forEach(function (item) {
            m3u += '#EXTINF:-1,' + item.title + '\n' + item.url + '\n';
        });

        var ok = downloadM3U(m3u, collected.length);
        var msg = (reason ? reason + ': ' : 'Готово: ') + collected.length + ' серий';
        if (ok) msg += ' · M3U скачан';
        notify(msg);
    }

    function downloadM3U(m3uText, count) {
        try {
            var filename = 'lampa-iina-' + count + 'ep-' + Date.now() + '.m3u';
            var blob = new Blob(['\ufeff' + m3uText], { type: 'application/x-mpegurl;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(function() {
                if (a.parentNode) a.parentNode.removeChild(a);
                URL.revokeObjectURL(url);
            }, 1500);
            return true;
        } catch (e) {
            log('Download failed:', e);
            return false;
        }
    }

    // ================== ОТЛАДКА ==================
    window.iinaDebug = function () {
        var $c = $('.torrent-filter');
        var info = {
            'torrent-filter найден': $c.length,
            'iina-btn в нём': $c.find('.iina-btn').length,
            'фильтров рядом': $c.find('.simple-button--filter').length,
            'серий online__body': $('.online__body').length
        };
        console.table(info);
        if ($c.length) console.log('torrent-filter HTML:', $c.html());
        return info;
    };

    // ================== ИНИЦИАЛИЗАЦИЯ ==================
    function onActivity(e) {
        var t = e.type;
        var comp = (e.component || (e.object && e.object.component) || '').toString();

        if (t === 'start') {
            removeButton();
            if (comp.indexOf('online') === -1) stopPolling();
            else startPolling();
        }
    }

    function init() {
        log('Плагин v7 инициализирован');
        Lampa.Listener.follow('activity', onActivity);

        $(document).on('keydown.iina_playlist', function (e) {
            if (state.collecting && (e.keyCode === 8 || e.key === 'Backspace')) {
                state.cancelled = true;
                closePlayer();
                e.preventDefault();
                e.stopPropagation();
                return false;
            }
        });
    }

    if (window.appready) init();
    else Lampa.Listener.follow('app', function (e) {
        if (e.type === 'ready') init();
    });
})();

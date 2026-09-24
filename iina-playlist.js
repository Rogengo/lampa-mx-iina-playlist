/**
 * IINA Playlist Plugin для Lampa (v3)
 * - Собирает ссылки со всех серий в DOM
 * - Скачивает M3U-файл
 * - Пытается открыть IINA напрямую через iina://
 */
(function () {
    'use strict';
    if (window.__iina_playlist_v3__) return;
    window.__iina_playlist_v3__ = true;

    var CONFIG = {
        EPISODE_DELAY:   1200,
        PLAYER_TIMEOUT:  15000,
        AFTER_START_WAIT: 800,
        BUTTON_RETRY:    30,
        BUTTON_DELAY:    500,
        TRY_OPEN_IINA:   true,   // пытаться открывать IINA напрямую
        IINA_OPEN_DELAY: 600     // пауза между вызовами iina://
    };

    var state = { collecting: false, cancelled: false, progressEl: null };

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
        var $btn = $(
            '<div class="iina-btn selector" style="' +
                'display:inline-flex;align-items:center;gap:.5em;' +
                'height:2.4em;padding:0 1.1em;margin-left:.6em;' +
                'border-radius:.35em;cursor:pointer;' +
                'background:rgba(255,255,255,.10);color:#fff;' +
                'font-size:1em;line-height:1;box-sizing:border-box;' +
                'transition:background .15s;white-space:nowrap;' +
                'user-select:none;vertical-align:middle;">' +
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" ' +
                    'style="flex-shrink:0;opacity:.9;">' +
                    '<path d="M3 5h13v2H3V5zm0 5h13v2H3v-2zm0 5h9v2H3v-2zm14-1.5l5 3.5-5 3.5v-7z"/>' +
                '</svg>' +
                '<span>Плейлист IINA</span>' +
            '</div>'
        );
        $btn.on('mouseenter', function(){ $(this).css('background','rgba(255,255,255,.22)'); });
        $btn.on('mouseleave', function(){ $(this).css('background','rgba(255,255,255,.10)'); });
        $btn.on('hover:enter click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (state.collecting) { notify('Уже выполняется'); return; }
            startCollection();
        });
        return $btn;
    }

    function tryAddButton() {
        if ($('.iina-btn').length) return true;

        var $btn = createButton();

        // Ищем ряд с "Балансер" и "Фильтр" — вставляем кнопку туда же
        var $selectboxes = $('[class*="selectbox"]').filter(function () {
            var t = $(this).text();
            return t.indexOf('Балансер') >= 0 || t.indexOf('Фильтр') >= 0;
        });

        if ($selectboxes.length) {
            // Поднимаемся до общего родителя, в котором обе кнопки
            var $row = $selectboxes.first().parent();
            for (var depth = 0; depth < 5 && $row.length && !$row.is('body'); depth++) {
                if ($row.find('[class*="selectbox"]').length >= 2) break;
                $row = $row.parent();
            }
            if ($row.length && !$row.is('body')) {
                $row.append($btn);
                log('Кнопка добавлена в ряд с selectbox');
                return true;
            }
        }

        // Fallback: fixed в правом верхнем углу
        $btn.css({
            position: 'fixed', top: '4.8em', right: '1em', zIndex: 9999,
            background: 'rgba(0,0,0,.75)',
            border: '1px solid rgba(255,255,255,.2)'
        });
        $('body').append($btn);
        log('Кнопка добавлена как floating');
        return true;
    }

    function attemptAddButton(n) {
        if (tryAddButton()) return;
        if (n >= CONFIG.BUTTON_RETRY) { log('Кнопка не добавлена'); return; }
        setTimeout(function(){ attemptAddButton(n + 1); }, CONFIG.BUTTON_DELAY);
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

        var downloaded = downloadM3U(m3u, collected.length);

        var msg = (reason ? reason + ': ' : 'Готово: ') + collected.length + ' серий';
        if (downloaded) msg += ' · M3U скачан';
        notify(msg);

        if (CONFIG.TRY_OPEN_IINA) {
            // Небольшая задержка, чтобы нотификация успела появиться
            setTimeout(function(){ openInIINA(collected); }, 400);
        }
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

    function openInIINA(episodes) {
        // Используем iina://weblink?url=...
        // IINA добавляет последующие ссылки в текущий плейлист, если уже запущен
        var urls = episodes.map(function(e){ return e.url; });
        var i = 0;
        function next() {
            if (i >= urls.length || state.cancelled) {
                log('Открытие IINA завершено');
                return;
            }
            var url = urls[i]; i++;
            try {
                var a = document.createElement('a');
                a.href = 'iina://weblink?url=' + encodeURIComponent(url);
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                setTimeout(function() {
                    if (a.parentNode) a.parentNode.removeChild(a);
                }, 500);
                log('→ IINA:', i + '/' + urls.length);
            } catch (e) { log('IINA err:', e); }
            setTimeout(next, CONFIG.IINA_OPEN_DELAY);
        }
        next();
    }

    // ================== ИНИЦИАЛИЗАЦИЯ ==================
    function onActivity(e) {
        var t = e.type;
        var comp = (e.component || (e.object && e.object.component) || '').toString();
        if (t !== 'start' && t !== 'ready' && t !== 'complite') return;
        if (comp.indexOf('online') === -1) return;
        setTimeout(function(){ attemptAddButton(0); }, 400);
    }

    function init() {
        log('Плагин v3 инициализирован');
        Lampa.Listener.follow('activity', onActivity);
        try {
            var obs = new MutationObserver(function () {
                if ($('.online__body').length && !$('.iina-btn').length) {
                    attemptAddButton(0);
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        } catch (e) {}
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

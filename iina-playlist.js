/**
 * IINA Playlist Plugin для Lampa (v2 — поддержка online_mod)
 * Собирает ссылки на все видимые серии и формирует M3U-плейлист.
 */
(function () {
    'use strict';

    if (window.__iina_playlist_v2__) return;
    window.__iina_playlist_v2__ = true;

    var CONFIG = {
        EPISODE_DELAY:    1200,
        PLAYER_TIMEOUT:   15000,
        AFTER_START_WAIT: 800,
        BUTTON_RETRY:     20,
        BUTTON_DELAY:     500
    };

    var state = { collecting: false, cancelled: false, progressEl: null };

    function log() {
        var a = Array.prototype.slice.call(arguments);
        a.unshift('[IINA Playlist]');
        try { console.log.apply(console, a); } catch (e) {}
    }

    function notify(msg) {
        try {
            if (window.Lampa && Lampa.Noty) Lampa.Noty.show(msg);
            else log('NOTY:', msg);
        } catch (e) {}
    }

    // ---------------- Clipboard ----------------
    function copyText(text) {
        return new Promise(function (resolve) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text)
                    .then(function () { resolve(true); })
                    .catch(function () { fallbackCopy(text); resolve(true); });
            } else { fallbackCopy(text); resolve(true); }
        });
    }
    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); }
        catch (e) { log('Copy failed. Playlist:'); console.log(text); }
        document.body.removeChild(ta);
    }

    // ---------------- Кнопка ----------------
    function createButton() {
        var $btn = $(
            '<div class="selector view--iina-playlist" style="' +
                'display:inline-flex;align-items:center;gap:.5em;' +
                'padding:.5em 1em;margin:.3em;cursor:pointer;' +
                'background:rgba(255,255,255,.12);border-radius:.4em;' +
                'font-size:.95em;vertical-align:middle;">' +
                '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" style="flex-shrink:0">' +
                    '<path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM12 5.5v9l6-4.5-6-4.5z"/>' +
                '</svg>' +
                '<span>Плейлист IINA</span>' +
            '</div>'
        );
        $btn.on('hover:enter click', function (e) {
            e.preventDefault(); e.stopPropagation();
            if (state.collecting) { notify('Уже выполняется'); return; }
            startCollection();
        });
        return $btn;
    }

    function tryAddButton() {
        if ($('.view--iina-playlist').length) return true;

        var $btn = createButton();

        // 1) рядом с selectbox-ами (Балансер/Фильтр)
        var $selectboxes = $('[class*="selectbox"]').filter(function () {
            return $(this).closest('[class*="online"]').length > 0;
        });
        if ($selectboxes.length) {
            var $container = $selectboxes.first().parent();
            if ($container.length) {
                $container.append($btn);
                log('Кнопка добавлена рядом с selectbox');
                return true;
            }
        }

        // 2) в шапку, где лежат сами серии
        var $firstBody = $('.online__body').first();
        if ($firstBody.length) {
            var $list = $firstBody.closest('[class*="online"]');
            if ($list.length) {
                $list.first().prepend($btn);
                log('Кнопка добавлена в шапку списка');
                return true;
            }
        }

        // 3) floating (страховка)
        $('body > .view--iina-playlist').remove();
        $btn.css({
            position: 'fixed', top: '5em', right: '1em',
            zIndex: 10000, background: 'rgba(0,0,0,.75)', color: '#fff'
        });
        $('body').append($btn);
        log('Кнопка добавлена как floating');
        return true;
    }

    function attemptAddButton(attempt) {
        if (tryAddButton()) return;
        if (attempt >= CONFIG.BUTTON_RETRY) {
            log('Не удалось добавить кнопку');
            return;
        }
        setTimeout(function () { attemptAddButton(attempt + 1); }, CONFIG.BUTTON_DELAY);
    }

    // ---------------- Прогресс ----------------
    function showProgress(current, total) {
        if (!state.progressEl) {
            state.progressEl = $(
                '<div style="' +
                    'position:fixed;bottom:2em;left:50%;transform:translateX(-50%);' +
                    'background:rgba(0,0,0,.9);color:#fff;padding:1em 2em;' +
                    'border-radius:.5em;z-index:99999;font-size:1.1em;text-align:center;' +
                    'pointer-events:none;min-width:20em;">' +
                '</div>'
            );
            $('body').append(state.progressEl);
        }
        state.progressEl.html(
            'Сбор плейлиста: <b>' + current + ' / ' + total + '</b>' +
            '<br><small style="opacity:.7">Backspace — отмена</small>'
        );
    }
    function hideProgress() {
        if (state.progressEl) { state.progressEl.remove(); state.progressEl = null; }
    }

    // ---------------- Хук на плеер ----------------
    function attachPlayerHook(onStream) {
        var captured = false;
        var origPlay = null;
        var attached = false;

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
        } catch (e) { log('Hook attach error', e); }

        return function detach() {
            if (attached && origPlay) {
                try { Lampa.Player.play = origPlay; } catch (e) {}
            }
        };
    }

    function extractUrl(stream) {
        if (!stream) return null;
        return stream.url ||
               stream.stream_url ||
               stream.file ||
               (stream.stream && stream.stream.url) ||
               null;
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
        } catch (e) { log('closePlayer error', e); }
    }

    // ---------------- Сбор эпизодов из DOM ----------------
    function getEpisodesFromDOM() {
        var list = [];
        $('.online__body').each(function () {
            var $body = $(this);
            var $title = $body.find('.online__title');
            var title = $title.length ? $title.text().trim() : 'Серия';
            list.push({
                title: title,
                $trigger: $body.parent(), // .online.selector
                $body: $body
            });
        });
        return list;
    }

    function startCollection() {
        var episodes = getEpisodesFromDOM();
        if (!episodes.length) { notify('Серии не найдены'); return; }

        state.collecting = true;
        state.cancelled = false;
        log('Начинаю сбор:', episodes.length, 'серий');
        showProgress(0, episodes.length);
        processNext(episodes, 0, []);
    }

    function processNext(episodes, index, collected) {
        if (state.cancelled) { finish(collected, 'Отменено'); return; }
        if (index >= episodes.length) { finish(collected, null); return; }

        var ep = episodes[index];
        showProgress(index + 1, episodes.length);
        log('---', ep.title, '(' + (index + 1) + '/' + episodes.length + ')');

        var detach = null;
        var done = false;

        function complete() {
            if (done) return;
            done = true;
            if (detach) detach();
            closePlayer();
            setTimeout(function () {
                processNext(episodes, index + 1, collected);
            }, CONFIG.EPISODE_DELAY);
        }

        var timeoutId = setTimeout(function () {
            log('Таймаут:', ep.title);
            complete();
        }, CONFIG.PLAYER_TIMEOUT);

        detach = attachPlayerHook(function (stream) {
            clearTimeout(timeoutId);
            var url = extractUrl(stream);
            if (url && /^https?:/i.test(url)) {
                collected.push({ title: ep.title, url: url });
                log('✓', url);
            } else {
                log('✗ URL не найден в stream:', stream);
            }
            setTimeout(complete, CONFIG.AFTER_START_WAIT);
        });

        try {
            var $trigger = ep.$trigger.length ? ep.$trigger : ep.$body;
            $trigger.trigger('hover:enter');
            $trigger.trigger('click');
            log('Trigger sent');
        } catch (e) {
            clearTimeout(timeoutId);
            log('Trigger error', e);
            complete();
        }
    }

    function finish(collected, reason) {
        state.collecting = false;
        state.cancelled = false;
        hideProgress();

        if (!collected.length) { notify('Ссылки не собраны'); return; }

        var m3u = '#EXTM3U\n';
        collected.forEach(function (item) {
            m3u += '#EXTINF:-1,' + item.title + '\n' + item.url + '\n';
        });

        copyText(m3u).then(function () {
            notify((reason ? reason + ': ' : 'Готово: ') + collected.length + ' серий скопировано');
        });
    }

    // ---------------- Инициализация ----------------
    function onActivity(e) {
        var t = e.type;
        var comp = (e.component || (e.object && e.object.component) || '').toString();
        log('Activity:', t, comp || '(no component)');
        if (t !== 'start' && t !== 'ready' && t !== 'complite') return;
        if (comp.indexOf('online') === -1) return;
        setTimeout(function () { attemptAddButton(0); }, 400);
    }

    function init() {
        log('Плагин v2 инициализирован');

        Lampa.Listener.follow('activity', onActivity);

        // Fallback: следим за DOM
        try {
            var obs = new MutationObserver(function () {
                if ($('.online__body').length && !$('.view--iina-playlist').length) {
                    attemptAddButton(0);
                }
            });
            obs.observe(document.body, { childList: true, subtree: true });
        } catch (e) { log('Observer error', e); }

        // Отмена
        $(document).on('keydown.iina_playlist', function (e) {
            if (state.collecting && (e.keyCode === 8 || e.key === 'Backspace')) {
                log('Отмена пользователем');
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

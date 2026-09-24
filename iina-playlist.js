/**
 * IINA Playlist Plugin для Lampa
 * Собирает ссылки на все серии и формирует M3U-плейлист для IINA.
 * Версия: 1.0.0
 */
(function () {
    'use strict';

    // ================================================================
    // ЗАЩИТА ОТ ПОВТОРНОЙ ЗАГРУЗКИ
    // ================================================================
    if (window.__iina_playlist_plugin__) return;
    window.__iina_playlist_plugin__ = true;

    // ================================================================
    // КОНФИГУРАЦИЯ
    // ================================================================
    var CONFIG = {
        EPISODE_DELAY:    1200,   // пауза между запусками серий (мс)
        PLAYER_TIMEOUT:   10000,  // сколько ждать старта плеера (мс)
        AFTER_START_WAIT: 800,    // пауза после старта перед закрытием (мс)
        BUTTON_WAIT:      250     // задержка перед добавлением кнопки (мс)
    };

    // ================================================================
    // СОСТОЯНИЕ
    // ================================================================
    var state = {
        collecting: false,
        cancelled: false,
        progressEl: null,
        playerRestore: null // функция восстановления Player.play
    };

    // ================================================================
    // УТИЛИТЫ
    // ================================================================
    function log() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[IINA Playlist]');
        try { console.log.apply(console, args); } catch (e) {}
    }

    function notify(msg) {
        try {
            if (window.Lampa && Lampa.Noty && typeof Lampa.Noty.show === 'function') {
                Lampa.Noty.show(msg);
            } else {
                log('NOTY:', msg);
            }
        } catch (e) { log('notify error', e); }
    }

    function pad(n) {
        return (n < 10 ? '0' : '') + n;
    }

    // ================================================================
    // БУФЕР ОБМЕНА
    // ================================================================
    function copyToClipboard(text) {
        return new Promise(function (resolve) {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text)
                    .then(function () { resolve(true); })
                    .catch(function () { fallbackCopy(text); resolve(true); });
            } else {
                fallbackCopy(text);
                resolve(true);
            }
        });
    }

    function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); }
        catch (e) {
            log('Не удалось скопировать. Плейлист в консоли:');
            console.log(text);
        }
        document.body.removeChild(ta);
    }

    // ================================================================
    // UI: КНОПКА
    // ================================================================
    function addButton(activity) {
        if (!activity || !activity.render) return;
        var render;
        try { render = activity.render(); } catch (e) { return; }
        if (!render || !render.length) return;
        if (render.find('.view--iina-playlist').length) return;

        var $btn = $(
            '<div class="full-start__button selector view--iina-playlist">' +
                '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">' +
                    '<path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H8V4h12v12zM12 5.5v9l6-4.5-6-4.5z"/>' +
                '</svg>' +
                '<span>Плейлист для IINA</span>' +
            '</div>'
        );

        $btn.on('hover:enter', function () {
            if (state.collecting) { notify('Уже выполняется'); return; }
            startCollection(activity);
        });

        // Пробуем несколько контейнеров на случай разных версий Lampa
        var $target = render.find('.full-start__buttons');
        if (!$target.length) $target = render.find('.full-start');
        if (!$target.length) $target = render.find('.full');

        $target.append($btn);
        log('Кнопка добавлена');
    }

    // ================================================================
    // UI: ПРОГРЕСС
    // ================================================================
    function showProgress(current, total) {
        if (!state.progressEl) {
            state.progressEl = $(
                '<div class="iina-progress" style="' +
                    'position:fixed;bottom:2em;left:50%;transform:translateX(-50%);' +
                    'background:rgba(0,0,0,.85);color:#fff;padding:1em 2em;' +
                    'border-radius:.5em;z-index:99999;font-size:1.1em;text-align:center;' +
                    'pointer-events:none;">' +
                '</div>'
            );
            $('body').append(state.progressEl);
        }
        state.progressEl.html(
            'Сбор плейлиста: ' + current + ' / ' + total +
            '<br><small style="opacity:.7">Backspace — отмена</small>'
        );
    }

    function hideProgress() {
        if (state.progressEl) {
            state.progressEl.remove();
            state.progressEl = null;
        }
    }

    // ================================================================
    // ИЗВЛЕЧЕНИЕ СПИСКА ЭПИЗОДОВ
    // ================================================================
    function extractEpisodes(movie) {
        var result = [];
        if (!movie) return result;

        var seasons = movie.seasons || [];
        if (!seasons.length) return result;

        seasons.forEach(function (season) {
            var sn = season.number || season.season_number || season.season || 1;
            var episodes = season.episodes || [];
            episodes.forEach(function (ep) {
                var en = ep.number || ep.episode_number || ep.episode || 0;
                result.push({
                    season: sn,
                    episode: en,
                    title: (movie.name || movie.title || 'Series') +
                           ' S' + pad(sn) + 'E' + pad(en) +
                           (ep.title ? ' — ' + ep.title : ''),
                    data: ep
                });
            });
        });

        return result;
    }

    // ================================================================
    // ПОИСК КОМПОНЕНТА ONLINE
    // ================================================================
    function findOnlineComponent() {
        try {
            var active = Lampa.Activity.active();
            if (!active) return null;

            if (active.object && active.object.component === 'online') return active.object;
            if (active.component === 'online' && active.object) return active.object;

            // Через реестр компонентов
            if (window.Lampa && Lampa.Component && typeof Lampa.Component.get === 'function') {
                var comp = Lampa.Component.get('online');
                if (comp) return comp;
            }
        } catch (e) {
            log('findOnlineComponent error', e);
        }
        return null;
    }

    // ================================================================
    // ПЕРЕХВАТ ССЫЛКИ
    // ================================================================
    /**
     * Ставит хук на Lampa.Player.play и на событие 'player'.
     * Возвращает функцию-detach для снятия хука.
     * Гарантированно восстанавливает оригинал через try/finally.
     */
    function attachPlayerHook(onStream) {
        var captured = false;
        var originals = [];

        // --- Способ 1: обёртка Player.play ---
        var origPlay = null;
        try {
            if (window.Lampa && Lampa.Player && typeof Lampa.Player.play === 'function') {
                origPlay = Lampa.Player.play;
                Lampa.Player.play = function (stream) {
                    if (!captured && stream) {
                        captured = true;
                        try { onStream(stream); }
                        catch (e) { log('onStream error', e); }
                    }
                    return origPlay.apply(this, arguments);
                };
                originals.push({
                    target: Lampa.Player,
                    key: 'play',
                    value: origPlay
                });
            }
        } catch (e) {
            log('Не удалось обернуть Player.play', e);
        }

        // --- Способ 2: слушатель player ---
        var listenerHandler = null;
        var listenerAttached = false;
        try {
            listenerHandler = function (e) {
                if (captured) return;
                if (e && (e.type === 'start' || e.type === 'play')) {
                    captured = true;
                    try { onStream(e.data || e.stream || e); }
                    catch (err) { log('onStream (listener) error', err); }
                }
            };
            Lampa.Listener.follow('player', listenerHandler);
            listenerAttached = true;
        } catch (e) {
            log('Не удалось подписаться на player listener', e);
        }

        // --- Функция отмены ---
        return function detach() {
            originals.forEach(function (item) {
                try { item.target[item.key] = item.value; }
                catch (e) { log('detach error', e); }
            });
            if (listenerAttached && listenerHandler) {
                try { Lampa.Listener.unfollow('player', listenerHandler); }
                catch (e) { log('unfollow error', e); }
            }
        };
    }

    // ================================================================
    // ЗАПУСК ЭПИЗОДА
    // ================================================================
    /**
     * Пытается запустить воспроизведение серии несколькими способами.
     * Возвращает true, если удалось инициировать.
     */
    function playEpisode(onlineComponent, epData, index) {
        // --- Способ 1: через метод play() компонента ---
        if (onlineComponent && typeof onlineComponent.play === 'function') {
            try {
                onlineComponent.play(epData);
                log('play через onlineComponent.play()');
                return true;
            } catch (e) {
                log('onlineComponent.play() failed:', e);
            }
        }

        // --- Способ 2: через метод onSelect() ---
        if (onlineComponent && typeof onlineComponent.onSelect === 'function') {
            try {
                onlineComponent.onSelect(epData);
                log('play через onlineComponent.onSelect()');
                return true;
            } catch (e) {
                log('onlineComponent.onSelect() failed:', e);
            }
        }

        // --- Способ 3: DOM-элемент по индексу ---
        var $items = $('.online.selector');
        if ($items.length > index) {
            var $body = $items.eq(index).find('.online__body');
            if ($body.length) {
                // В Lampa основное событие — hover:enter, click — запасной вариант
                $body.trigger('hover:enter');
                $body.trigger('click');
                log('play через DOM trigger');
                return true;
            }
        }

        return false;
    }

    // ================================================================
    // ЗАКРЫТИЕ ПЛЕЕРА
    // ================================================================
    function closePlayer() {
        try {
            if (window.Lampa && Lampa.Player) {
                if (typeof Lampa.Player.close === 'function') {
                    Lampa.Player.close();
                    return;
                }
                if (typeof Lampa.Player.destroy === 'function') {
                    Lampa.Player.destroy();
                    return;
                }
            }
            // Fallback: эмулируем Backspace
            var ev = $.Event('keydown');
            ev.keyCode = 8;
            ev.which = 8;
            $(document).trigger(ev);
        } catch (e) {
            log('closePlayer error', e);
        }
    }

    // ================================================================
    // ОСНОВНОЙ ПРОЦЕСС
    // ================================================================
    function startCollection(activity) {
        var movie = (activity.object && activity.object.data) || activity.data;
        if (!movie) { notify('Нет данных о сериале'); return; }

        var episodes = extractEpisodes(movie);
        if (!episodes.length) { notify('Серии не найдены'); return; }

        state.collecting = true;
        state.cancelled = false;

        log('Начинаю сбор:', episodes.length, 'эпизодов');

        var onlineComponent = findOnlineComponent();
        if (!onlineComponent) {
            log('Компонент Online не найден — буду использовать DOM');
        }

        showProgress(1, episodes.length);
        processNext(episodes, 0, [], onlineComponent);
    }

    function processNext(episodes, index, collected, onlineComponent) {
        // --- Проверки выхода ---
        if (state.cancelled) {
            finish(collected, 'Отменено');
            return;
        }
        if (index >= episodes.length) {
            finish(collected, null);
            return;
        }

        var ep = episodes[index];
        showProgress(index + 1, episodes.length);
        log('---', ep.title, '(' + (index + 1) + '/' + episodes.length + ')');

        var detach = null;
        var timeoutId = setTimeout(function () {
            log('Таймаут старта плеера:', ep.title);
            if (detach) detach();
            closePlayer();
            // Продолжаем со следующей
            setTimeout(function () {
                processNext(episodes, index + 1, collected, onlineComponent);
            }, CONFIG.EPISODE_DELAY);
        }, CONFIG.PLAYER_TIMEOUT);

        // --- Ставим хук на плеер ---
        detach = attachPlayerHook(function (stream) {
            clearTimeout(timeoutId);
            if (detach) detach();

            // Извлекаем URL — разные версии Lampa кладут его в разные поля
            var url = stream.url ||
                      stream.stream_url ||
                      stream.file ||
                      (stream.stream && stream.stream.url) ||
                      null;

            if (url && /^https?:/i.test(url)) {
                collected.push({ title: ep.title, url: url });
                log('✓', ep.title, url);
            } else {
                log('✗ URL не найден в stream:', stream);
            }

            // Небольшая пауза — дать плееру начать воспроизведение
            setTimeout(function () {
                closePlayer();
                setTimeout(function () {
                    processNext(episodes, index + 1, collected, onlineComponent);
                }, CONFIG.EPISODE_DELAY);
            }, CONFIG.AFTER_START_WAIT);
        });

        // --- Запускаем эпизод ---
        var ok = playEpisode(onlineComponent, ep.data, index);
        if (!ok) {
            clearTimeout(timeoutId);
            if (detach) detach();
            log('Не удалось запустить воспроизведение:', ep.title);
            setTimeout(function () {
                processNext(episodes, index + 1, collected, onlineComponent);
            }, 100);
        }
    }

    // ================================================================
    // ФИНАЛ
    // ================================================================
    function finish(collected, cancelReason) {
        state.collecting = false;
        state.cancelled = false;
        hideProgress();

        if (!collected.length) {
            notify('Ссылки не собраны');
            return;
        }

        var m3u = '#EXTM3U\n';
        collected.forEach(function (item) {
            m3u += '#EXTINF:-1,' + item.title + '\n' + item.url + '\n';
        });

        copyToClipboard(m3u).then(function () {
            var prefix = cancelReason ? cancelReason + ': ' : 'Готово: ';
            notify(prefix + collected.length + ' ссылок скопировано в буфер');
        });
    }

    // ================================================================
    // ИНИЦИАЛИЗАЦИЯ
    // ================================================================
    function init() {
        log('Плагин инициализирован');

        // --- Кнопка на странице сериала ---
        Lampa.Listener.follow('full', function (e) {
            if (e.type === 'complite' &&
                e.data && e.data.seasons && e.data.seasons.length) {
                setTimeout(function () {
                    addButton(e.object);
                }, CONFIG.BUTTON_WAIT);
            }
        });

        // --- Отмена по Backspace ---
        $(document).on('keydown.iina_playlist', function (e) {
            if (state.collecting && (e.keyCode === 8 || e.key === 'Backspace')) {
                log('Отмена пользователем');
                state.cancelled = true;
                closePlayer();
                e.preventDefault();
                e.stopPropagation();
            }
        });
    }

    if (window.appready) {
        init();
    } else {
        Lampa.Listener.follow('app', function (e) {
            if (e.type === 'ready') init();
        });
    }
})();
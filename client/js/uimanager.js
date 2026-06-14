
/**
 * UIManager — owns every direct DOM read / write that was previously
 * scattered across app.js.
 *
 * Responsibilities
 * ----------------
 * • Play-button state (enabled / disabled / loading spinner)
 * • Intro → game page transition
 * • Health-bar rendering & blink effect
 * • Equipment icons (weapon / armor)
 * • Chat box visibility
 * • Achievement list, unlock display & notification toast
 * • In-game notification messages (top bar)
 * • Parchment page animation (credits / about / load / create / confirm)
 * • Social-share popup
 * • UI resize delegation
 *
 * This module does NOT decide *when* to show or hide things —
 * that is the job of App (orchestration) and StateManager (lifecycle).
 */
define(['jquery'], function($) {

    var UIManager = Class.extend({
        init: function() {
            this.currentPage = 1;
            this.blinkInterval = null;
            this.isParchmentReady = true;
            this.messageTimer = null;
            this.watchNameInputInterval = null;

            this.$playButton = $('.play');
            this.$playDiv    = $('.play div');
        },

        // ──────────────────────────────────────────────────────────────────
        // Play-button state
        // ──────────────────────────────────────────────────────────────────

        /** Poll the name input and toggle the Play button accordingly. */
        startWatchingNameInput: function() {
            this.watchNameInputInterval = setInterval(
                this.updatePlayButtonState.bind(this), 100
            );
        },

        stopWatchingNameInput: function() {
            clearInterval(this.watchNameInputInterval);
        },

        updatePlayButtonState: function() {
            var name  = $('#parchment input').val();
            var $play = $('#createcharacter .play');

            if (name && name.length > 0) {
                $play.removeClass('disabled');
                $('#character').removeClass('disabled');
            } else {
                $play.addClass('disabled');
                $('#character').addClass('disabled');
            }
        },

        showPlayLoading: function(isMobile) {
            if (!isMobile) {
                this.$playButton.addClass('loading');
            }
            this.$playDiv.unbind('click');
        },

        hidePlayLoading: function(isMobile) {
            if (!isMobile) {
                this.$playButton.removeClass('loading');
            }
        },

        unbindPlayClick: function() {
            this.$playDiv.unbind('click');
        },

        // ──────────────────────────────────────────────────────────────────
        // Page / intro transitions
        // ──────────────────────────────────────────────────────────────────

        hideIntro: function(callback) {
            this.stopWatchingNameInput();
            $('body').removeClass('intro');
            setTimeout(function() {
                $('body').addClass('game');
                if (callback) { callback(); }
            }, 1000);
        },

        // ──────────────────────────────────────────────────────────────────
        // Health bar
        // ──────────────────────────────────────────────────────────────────

        initHealthBar: function(game) {
            var scale          = game.renderer.getScaleFactor();
            var healthMaxWidth = $("#healthbar").width() - (12 * scale);

            game.onPlayerHealthChange(function(hp, maxHp) {
                var barWidth = Math.round(
                    (healthMaxWidth / maxHp) * (hp > 0 ? hp : 0)
                );
                $("#hitpoints").css('width', barWidth + "px");
            });

            game.onPlayerHurt(this.blinkHealthBar.bind(this));
        },

        blinkHealthBar: function() {
            var $hitpoints = $('#hitpoints');
            $hitpoints.addClass('white');
            setTimeout(function() {
                $hitpoints.removeClass('white');
            }, 500);
        },

        toggleInvincible: function() {
            $('#hitpoints').toggleClass('invincible');
        },

        // ──────────────────────────────────────────────────────────────────
        // Equipment icons
        // ──────────────────────────────────────────────────────────────────

        initEquipmentIcons: function(game) {
            var scale = game.renderer.getScaleFactor();
            var getIconPath = function(spriteName) {
                return 'img/' + scale + '/item-' + spriteName + '.png';
            };

            var weapon     = game.player.getWeaponName();
            var armor      = game.player.getSpriteName();
            var weaponPath = getIconPath(weapon);
            var armorPath  = getIconPath(armor);

            $('#weapon').css('background-image', 'url("' + weaponPath + '")');
            if (armor !== 'firefox') {
                $('#armor').css('background-image', 'url("' + armorPath + '")');
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Chat
        // ──────────────────────────────────────────────────────────────────

        showChat: function(gameStarted) {
            if (gameStarted) {
                $('#chatbox').addClass('active');
                $('#chatinput').focus();
                $('#chatbutton').addClass('active');
            }
        },

        hideChat: function(gameStarted) {
            if (gameStarted) {
                $('#chatbox').removeClass('active');
                $('#chatinput').blur();
                $('#chatbutton').removeClass('active');
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Achievement notification toast
        // ──────────────────────────────────────────────────────────────────

        showAchievementNotification: function(id, name, achievementCount) {
            var $notif  = $('#achievement-notification');
            var $name   = $notif.find('.name');
            var $button = $('#achievementsbutton');

            $notif.removeClass().addClass('active achievement' + id);
            $name.text(name);

            if (achievementCount === 1) {
                this.blinkInterval = setInterval(function() {
                    $button.toggleClass('blink');
                }, 500);
            }

            setTimeout(function() {
                $notif.removeClass('active');
                $button.removeClass('blink');
            }, 5000);
        },

        clearAchievementBlink: function() {
            if (this.blinkInterval) {
                clearInterval(this.blinkInterval);
                this.blinkInterval = null;
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Achievement list (parchment pages)
        // ──────────────────────────────────────────────────────────────────

        displayUnlockedAchievement: function(id, game) {
            var $achievement = $('#achievements li.achievement' + id);
            var achievement  = game.getAchievementById(id);

            if (achievement && achievement.hidden) {
                this.setAchievementData($achievement, achievement.name, achievement.desc);
            }
            $achievement.addClass('unlocked');
        },

        unlockAchievement: function(id, name, achievementCount) {
            this.showAchievementNotification(id, name, achievementCount);
            var nb = parseInt($('#unlocked-achievements').text());
            $('#unlocked-achievements').text(nb + 1);
        },

        initAchievementList: function(achievements, openPopup) {
            var self           = this;
            var $lists         = $('#lists');
            var $page          = $('#page-tmpl');
            var $achievement   = $('#achievement-tmpl');
            var page           = 0;
            var count          = 0;
            var $p             = null;

            _.each(achievements, function(achievement) {
                count++;

                var $a = $achievement.clone();
                $a.removeAttr('id');
                $a.addClass('achievement' + count);

                if (!achievement.hidden) {
                    self.setAchievementData($a, achievement.name, achievement.desc);
                }

                $a.find('.twitter').attr(
                    'href',
                    'http://twitter.com/share?url=http%3A%2F%2Fbrowserquest.mozilla.org&text=I%20unlocked%20the%20%27' +
                    achievement.name +
                    '%27%20achievement%20on%20Mozilla%27s%20%23BrowserQuest%21&related=glecollinet:Creators%20of%20BrowserQuest%2Cwhatthefranck'
                );
                $a.show();

                $a.find('a').click(function() {
                    var url = $(this).attr('href');
                    openPopup('twitter', url);
                    return false;
                });

                if ((count - 1) % 4 === 0) {
                    page++;
                    $p = $page.clone();
                    $p.attr('id', 'page' + page);
                    $p.show();
                    $lists.append($p);
                }
                $p.append($a);
            });

            $('#total-achievements').text($('#achievements').find('li').length);
        },

        initUnlockedAchievements: function(ids, game) {
            var self = this;
            _.each(ids, function(id) {
                self.displayUnlockedAchievement(id, game);
            });
            $('#unlocked-achievements').text(ids.length);
        },

        setAchievementData: function($el, name, desc) {
            $el.find('.achievement-name').html(name);
            $el.find('.achievement-description').html(desc);
        },

        // ──────────────────────────────────────────────────────────────────
        // Instructions / achievements panel toggle
        // ──────────────────────────────────────────────────────────────────

        toggleInstructions: function() {
            if ($('#achievements').hasClass('active')) {
                this.toggleAchievements();
                $('#achievementsbutton').removeClass('active');
            }
            $('#instructions').toggleClass('active');
        },

        toggleAchievements: function() {
            if ($('#instructions').hasClass('active')) {
                this.toggleInstructions();
                $('#helpbutton').removeClass('active');
            }
            this.resetPage();
            $('#achievements').toggleClass('active');
        },

        resetPage: function() {
            var self          = this;
            var $achievements = $('#achievements');

            if ($achievements.hasClass('active')) {
                $achievements.bind(TRANSITIONEND, function() {
                    $achievements
                        .removeClass('page' + self.currentPage)
                        .addClass('page1');
                    self.currentPage = 1;
                    $achievements.unbind(TRANSITIONEND);
                });
            }
        },

        /** Close every open panel (instructions, achievements, credits, about). */
        hideAllWindows: function(handlers) {
            if ($('#achievements').hasClass('active')) {
                this.toggleAchievements();
                $('#achievementsbutton').removeClass('active');
            }
            if ($('#instructions').hasClass('active')) {
                this.toggleInstructions();
                $('#helpbutton').removeClass('active');
            }
            if ($('body').hasClass('credits')) {
                handlers.closeInGameCredits();
            }
            if ($('body').hasClass('about')) {
                handlers.closeInGameAbout();
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Notification messages (top bar)
        // ──────────────────────────────────────────────────────────────────

        showMessage: function(message) {
            var $wrapper = $('#notifications div');
            var $message = $('#notifications #message2');

            this.animateMessages();
            $message.text(message);

            if (this.messageTimer) {
                this.resetMessageTimer();
            }

            this.messageTimer = setTimeout(function() {
                $wrapper.addClass('top');
            }, 5000);
        },

        animateMessages: function() {
            $('#notifications div').addClass('top');
        },

        resetMessagesPosition: function() {
            var message = $('#message2').text();
            $('#notifications div').removeClass('top');
            $('#message2').text('');
            $('#message1').text(message);
        },

        resetMessageTimer: function() {
            clearTimeout(this.messageTimer);
        },

        // ──────────────────────────────────────────────────────────────────
        // Parchment animation (credits / about / load / create / confirm)
        // ──────────────────────────────────────────────────────────────────

        animateParchment: function(origin, destination, isMobile, isTablet) {
            var self     = this;
            var $parchment = $('#parchment');
            var duration = 1;

            if (isMobile) {
                $parchment.removeClass(origin).addClass(destination);
            } else {
                if (this.isParchmentReady) {
                    if (isTablet) { duration = 0; }
                    this.isParchmentReady = false;

                    $parchment.toggleClass('animate');
                    $parchment.removeClass(origin);

                    setTimeout(function() {
                        $('#parchment').toggleClass('animate');
                        $parchment.addClass(destination);
                    }, duration * 1000);

                    setTimeout(function() {
                        self.isParchmentReady = true;
                    }, duration * 1000);
                }
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Credits / about page helpers
        // ──────────────────────────────────────────────────────────────────

        setCreditsToggled: function() {
            $('#parchment').removeClass().addClass('credits');
            $('body').toggleClass('credits');
        },

        setAboutToggled: function() {
            $('#parchment').removeClass().addClass('about');
            $('body').toggleClass('about');
        },

        removeDeathClass: function() {
            $('body').removeClass('death');
        },

        addDeathClass: function() {
            $('body').addClass('death');
        },

        closeCredits: function() {
            $('body').removeClass('credits');
            $('#parchment').removeClass('credits');
        },

        closeAbout: function() {
            $('body').removeClass('about');
            $('#parchment').removeClass('about');
            $('#helpbutton').removeClass('active');
        },

        togglePopulationInfo: function() {
            $('#population').toggleClass('visible');
        },

        // ──────────────────────────────────────────────────────────────────
        // Social popup
        // ──────────────────────────────────────────────────────────────────

        openPopup: function(type, url) {
            var h = $(window).height();
            var w = $(window).width();
            var popupHeight, popupWidth;

            switch (type) {
                case 'twitter':
                    popupHeight = 450;
                    popupWidth  = 550;
                    break;
                case 'facebook':
                    popupHeight = 400;
                    popupWidth  = 580;
                    break;
            }

            var top  = (h / 2) - (popupHeight / 2);
            var left = (w / 2) - (popupWidth  / 2);

            var newwindow = window.open(
                url, 'name',
                'height=' + popupHeight + ',width=' + popupWidth +
                ',top=' + top + ',left=' + left
            );
            if (window.focus) { newwindow.focus(); }
        },

        // ──────────────────────────────────────────────────────────────────
        // UI resize
        // ──────────────────────────────────────────────────────────────────

        resizeUi: function(game) {
            if (!game) { return; }

            if (game.started) {
                game.resize();
                this.initHealthBar(game);
                game.updateBars();
            } else {
                var newScale = game.renderer.getScaleFactor();
                game.renderer.rescale(newScale);
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Player count display
        // ──────────────────────────────────────────────────────────────────

        updatePlayerCount: function(worldPlayers, totalPlayers) {
            var setWorldPlayersString = function(string) {
                $("#instance-population").find("span:nth-child(2)").text(string);
                $("#playercount").find("span:nth-child(2)").text(string);
            };
            var setTotalPlayersString = function(string) {
                $("#world-population").find("span:nth-child(2)").text(string);
            };

            $("#playercount").find("span.count").text(worldPlayers);
            $("#instance-population").find("span").text(worldPlayers);

            if (worldPlayers == 1) {
                setWorldPlayersString("player");
            } else {
                setWorldPlayersString("players");
            }

            $("#world-population").find("span").text(totalPlayers);

            if (totalPlayers == 1) {
                setTotalPlayersString("player");
            } else {
                setTotalPlayersString("players");
            }
        },

        // ──────────────────────────────────────────────────────────────────
        // Disconnect message
        // ──────────────────────────────────────────────────────────────────

        showDisconnectMessage: function(message) {
            $('#death').find('p').html(message + "<em>Please reload the page.</em>");
            $('#respawn').hide();
        }
    });

    return UIManager;
});

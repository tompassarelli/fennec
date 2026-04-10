flakeSelf:

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.palefox;

  chromeDir = ".mozilla/firefox/${cfg.profile}/chrome";

  userChromeContent = lib.concatStringsSep "\n" (
    [ ''/* palefox — entry point (managed by Home Manager)''
      '' *''
      '' * Toggle features in about:config (type "palefox." to see all options):''
      '' *   pfx.drawer.autohide — auto-collapse sidebar when mouse leaves''
      '' *''
      '' * To customize: set programs.palefox.extraConfig in your nix config,''
      '' * or edit user.css directly.''
      '' */''
      ""
      ''@import url("palefox.css");''
    ]
    ++ map (imp: ''@import url("${imp}");'') cfg.userChromeImports
    ++ [ ''@import url("user.css");'' ]
  );

  userCssContent = ''
    /* user overrides — managed by Home Manager (programs.palefox.extraConfig) */
    ${cfg.extraConfig}
  '';
in
{
  options.programs.palefox = {
    enable = lib.mkEnableOption "Palefox Firefox theme";

    profile = lib.mkOption {
      type = lib.types.str;
      default = "default-release";
      description = "Firefox profile name to install Palefox into.";
    };

    autohide = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Auto-collapse sidebar when mouse leaves (sets pfx.drawer.autohide in about:config).";
    };

    floatingUrlbar = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Float urlbar centered on viewport when focused (sets pfx.urlbar.float in about:config).";
    };

    sideberry = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Install the Sideberry extension via NUR. Requires NUR in your flake inputs.";
    };

    extraConfig = lib.mkOption {
      type = lib.types.lines;
      default = "";
      description = "Extra CSS appended to user.css.";
    };

    userChromeImports = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [];
      description = "Additional @import URLs for userChrome.css.";
    };
  };

  config = lib.mkIf cfg.enable {
    programs.firefox = {
      enable = true;
      profiles.${cfg.profile} = {
        settings = {
          "toolkit.legacyUserProfileCustomizations.stylesheets" = true;
          "sidebar.verticalTabs" = false;
          "sidebar.revamp" = false;
          "sidebar.position_start" = true;
          "pfx.drawer.autohide" = cfg.autohide;
          "pfx.urlbar.float" = cfg.floatingUrlbar;
        };
        extensions = lib.mkIf cfg.sideberry {
          packages = [
            pkgs.nur.repos.rycee.firefox-addons.sidebery
          ];
        };
      };
    };

    home.file."${chromeDir}/palefox.css" = {
      source = "${flakeSelf}/chrome/palefox.css";
    };

    home.file."${chromeDir}/userChrome.css" = {
      text = userChromeContent;
    };

    home.file."${chromeDir}/user.css" = {
      text = userCssContent;
    };
  };
}

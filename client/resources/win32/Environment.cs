using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

internal static partial class Sandbox
{
    internal static void ConfigureRuntime(IDictionary<string, string> env, Options options)
    {
        if (options.Distribution == "miktex") {
            env["MIKTEX_USERINSTALL"] = Path.Combine(options.Runtime, "install");
            env["MIKTEX_USERCONFIG"] = Path.Combine(options.Runtime, "config");
            env["MIKTEX_USERDATA"] = Path.Combine(options.Runtime, "data");
            env["MIKTEX_ENABLE_INSTALLER"] = "0";
            foreach (string prefix in new string[] { "", "PDFLATEX_", "PDFTEX_", "PDFETEX_", "XELATEX_", "XETEX_", "LATEX_", "TEX_", "MIKTEX_", "MIKTEXPDFLATEX_", "MIKTEXPDFTEX_", "MIKTEXPDFETEX_", "MIKTEXXELATEX_", "MIKTEXXETEX_" }) {
                env["MIKTEX_" + prefix + "CORE_ALLOWUNSAFEINPUTFILES"] = "false";
                env["MIKTEX_" + prefix + "CORE_ALLOWUNSAFEOUTPUTFILES"] = "false";
                env["MIKTEX_" + prefix + "CORE_SHELLCOMMANDMODE"] = "Forbidden";
                env["MIKTEX_" + prefix + "MPM_AUTOINSTALL"] = "0";
                env["MIKTEX_" + prefix + "TEXANDFRIENDS_PARSEFIRSTLINE"] = "false";
            }
        } else {
            env["TEXMFROOT"] = Path.Combine(options.Runtime, "install");
            env["TEXMFCNF"] = Path.Combine(options.Runtime, "install", "texmf-dist", "web2c");
            // Pinned app-authored fontconfig configuration for the patched XeTeX (patched-engines overlay).
            env["FONTCONFIG_FILE"] = Path.Combine(options.Runtime, "install", "bin", "paperstudio-x64", "fonts.conf");
            // Formats come only from the pinned runtime (hash-checked by the app's trust cache): no '.', no
            // $TEXMFHOME/$TEXMFVAR (both are the writable snapshot here) and no trailing ';' default path.
            string formats = Path.Combine(options.Runtime, "install", "texmf-var", "web2c").Replace('\\', '/');
            env["TEXFORMATS"] = formats + "/pdftex;" + formats + "/xetex";
        }
    }
    internal static string SearchPath(Options options, string subtree)
    {
        if (options.Distribution != "texlive") return ".;";
        string tree = Path.Combine(options.Runtime, "install", "texmf-paperstudio", subtree.Replace('/', Path.DirectorySeparatorChar));
        return ".;" + tree.Replace('\\', '/') + "//;";
    }
    internal static string EnvironmentBlock(Options options)
    {
        SortedDictionary<string, string> env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (string key in new string[] { "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL" }) {
            string value = Environment.GetEnvironmentVariable(key);
            if (!String.IsNullOrEmpty(value)) env[key] = value;
        }
        ConfigureRuntime(env, options);
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        env["PATH"] = Path.GetDirectoryName(options.Executable) + ";" + Path.Combine(windows, "System32");
        foreach (string key in new string[] { "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEXMFOUTPUT", "TEXMFVAR", "TEXMFCONFIG", "TEXMFCACHE" }) env[key] = options.Work;
        // Project first, then (TeX Live) the pinned app package tree, then kpathsea's default path (trailing ';').
        env["TEXINPUTS"] = SearchPath(options, "tex");
        env["BIBINPUTS"] = SearchPath(options, "bibtex/bib");
        env["BSTINPUTS"] = SearchPath(options, "bibtex/bst");
        env["openin_any"] = "p"; env["openout_any"] = "p"; env["shell_escape"] = "f";
        foreach (string key in new string[] { "MKTEXPK", "MKTEXTFM", "MKTEXFMT" }) env[key] = "0";
        return String.Join("\0", env.Select(item => item.Key + "=" + item.Value)) + "\0\0";
    }
}

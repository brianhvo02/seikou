/*
 * FreeType modules in freetype.wasm: the ones that load and render OpenType fonts (TrueType and CFF outlines), in
 * Ubuntu's order (tt before cff, as in its ftmodule.h). Discs ship OpenType fonts, and the fallback is the bundled
 * TrueType default-font.ttf; Type 1, CID, PFR, Type 42, Windows FNT, PCF and BDF fonts, the mono, SVG and SDF
 * renderers and the gxvalid/otvalid validators are left out.
 */
FT_USE_MODULE( FT_Driver_ClassRec, tt_driver_class )
FT_USE_MODULE( FT_Driver_ClassRec, cff_driver_class )
FT_USE_MODULE( FT_Module_Class, sfnt_module_class )
FT_USE_MODULE( FT_Module_Class, autofit_module_class )
FT_USE_MODULE( FT_Module_Class, pshinter_module_class )
FT_USE_MODULE( FT_Renderer_Class, ft_smooth_renderer_class )
FT_USE_MODULE( FT_Module_Class, psaux_module_class )
FT_USE_MODULE( FT_Module_Class, psnames_module_class )

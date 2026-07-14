from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "Winerim_Agora_brief_partner_v6_2026-07-14.pdf"

RED = colors.HexColor("#D92F43")
INK = colors.HexColor("#171A21")
MUTED = colors.HexColor("#667085")
PAPER = colors.HexColor("#F6F7F9")
LINE = colors.HexColor("#D9DDE5")
TEAL = colors.HexColor("#147D78")
AMBER = colors.HexColor("#B86B16")
WHITE = colors.white


class PartnerBriefDoc(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=18 * mm,
            bottomMargin=17 * mm,
            title="Winerim + Agora | Brief partner V6",
            author="Winerim",
            subject="Alcance tecnico y operativo de la integracion Winerim + Agora",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="normal")
        self.addPageTemplates(PageTemplate(id="main", frames=[frame], onPage=self.decorate_page))

    def decorate_page(self, canvas, doc):
        canvas.saveState()
        page = canvas.getPageNumber()
        width, height = A4
        if page == 1:
            canvas.setFillColor(INK)
            canvas.rect(0, 0, width, height, fill=1, stroke=0)
            canvas.setFillColor(RED)
            canvas.rect(0, height - 9 * mm, width, 9 * mm, fill=1, stroke=0)
        else:
            canvas.setStrokeColor(LINE)
            canvas.line(18 * mm, height - 12 * mm, width - 18 * mm, height - 12 * mm)
            canvas.setFont("Helvetica-Bold", 8)
            canvas.setFillColor(INK)
            canvas.drawString(18 * mm, height - 9 * mm, "Winerim + Agora")
            canvas.setFont("Helvetica", 8)
            canvas.setFillColor(MUTED)
            canvas.drawRightString(width - 18 * mm, height - 9 * mm, "Brief partner V6")

        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(WHITE if page == 1 else MUTED)
        canvas.drawString(18 * mm, 9 * mm, "Documento de trabajo para validacion tecnica y comercial")
        canvas.drawRightString(width - 18 * mm, 9 * mm, f"{page}")
        canvas.restoreState()


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="CoverEyebrow", parent=styles["Normal"], fontName="Helvetica-Bold",
    fontSize=9, leading=12, textColor=colors.HexColor("#FFB7C0"), spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="CoverTitle", parent=styles["Title"], fontName="Helvetica-Bold",
    fontSize=31, leading=35, textColor=WHITE, alignment=TA_LEFT, spaceAfter=13,
))
styles.add(ParagraphStyle(
    name="CoverSub", parent=styles["Normal"], fontName="Helvetica",
    fontSize=13, leading=19, textColor=colors.HexColor("#E6E8EC"), spaceAfter=20,
))
styles.add(ParagraphStyle(
    name="CoverMeta", parent=styles["Normal"], fontName="Helvetica",
    fontSize=9, leading=14, textColor=colors.HexColor("#C8CDD6"),
))
styles.add(ParagraphStyle(
    name="H1x", parent=styles["Heading1"], fontName="Helvetica-Bold",
    fontSize=20, leading=24, textColor=INK, spaceBefore=2, spaceAfter=9,
))
styles.add(ParagraphStyle(
    name="H2x", parent=styles["Heading2"], fontName="Helvetica-Bold",
    fontSize=12.5, leading=16, textColor=RED, spaceBefore=10, spaceAfter=5,
))
styles.add(ParagraphStyle(
    name="Bodyx", parent=styles["BodyText"], fontName="Helvetica",
    fontSize=9.3, leading=13.5, textColor=INK, spaceAfter=7,
))
styles.add(ParagraphStyle(
    name="Smallx", parent=styles["BodyText"], fontName="Helvetica",
    fontSize=8, leading=11, textColor=MUTED, spaceAfter=4,
))
styles.add(ParagraphStyle(
    name="Callout", parent=styles["BodyText"], fontName="Helvetica-Bold",
    fontSize=10.5, leading=15, textColor=INK, leftIndent=10, rightIndent=10,
    borderColor=RED, borderWidth=0, borderPadding=9, backColor=colors.HexColor("#FDECEE"),
    spaceBefore=7, spaceAfter=10,
))
styles.add(ParagraphStyle(
    name="Cell", parent=styles["BodyText"], fontName="Helvetica",
    fontSize=8.1, leading=10.8, textColor=INK,
))
styles.add(ParagraphStyle(
    name="CellHead", parent=styles["BodyText"], fontName="Helvetica-Bold",
    fontSize=8.1, leading=10.8, textColor=WHITE,
))
styles.add(ParagraphStyle(
    name="Step", parent=styles["BodyText"], fontName="Helvetica-Bold",
    fontSize=9, leading=12, textColor=INK,
))


def p(text, style="Bodyx"):
    return Paragraph(text, styles[style])


def bullet(text):
    return Paragraph(f"&#8226;&nbsp;&nbsp;{text}", styles["Bodyx"])


def table(data, widths, header=True):
    converted = []
    for row_index, row in enumerate(data):
        converted.append([
            cell if isinstance(cell, Paragraph) else p(str(cell), "CellHead" if header and row_index == 0 else "Cell")
            for cell in row
        ])
    result = Table(converted, colWidths=widths, repeatRows=1 if header else 0, hAlign="LEFT")
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
    ]
    if header:
        commands.extend([
            ("BACKGROUND", (0, 0), (-1, 0), INK),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PAPER]),
        ])
    else:
        commands.append(("ROWBACKGROUNDS", (0, 0), (-1, -1), [WHITE, PAPER]))
    result.setStyle(TableStyle(commands))
    return result


def section_title(number, title):
    return KeepTogether([
        p(f"{number}. {title}", "H1x"),
        HRFlowable(width="100%", thickness=1.2, color=RED, spaceAfter=9),
    ])


story = []

# Cover
story.extend([
    Spacer(1, 32 * mm),
    p("DOCUMENTO PARA PARTNER Y PILOTO CONTROLADO", "CoverEyebrow"),
    p("Winerim + Agora", "CoverTitle"),
    p("Catalogo de vino, ventas, stock y una extension segura para menus, armonias, tSpoonLab y Holded.", "CoverSub"),
    Spacer(1, 9 * mm),
    p("Agora mantiene la operacion de sala, comandas, cobros y cierres. Winerim aporta la capa especializada de vino. tSpoonLab y Holded se conectan sin convertir el TPV en responsable de escandallos o contabilidad.", "CoverSub"),
    Spacer(1, 17 * mm),
    table([
        [p("Preparado por", "CellHead"), p("Destinatario", "CellHead")],
        [p("Winerim - Goiko - CTO / Integraciones", "Cell"), p("Equipo tecnico-comercial de Agora / Servicios de Integracion", "Cell")],
        [p("14 de julio de 2026", "Cell"), p("Estado: documento de trabajo para validacion partner", "Cell")],
    ], [76 * mm, 82 * mm]),
    Spacer(1, 7 * mm),
    p("Contacto: goiko@winerim.com - +34 685 739 010", "CoverMeta"),
    PageBreak(),
])

# Page 2
story.extend([
    section_title("1", "Encaje de producto"),
    p("Winerim ayuda a restaurantes, hoteles y grupos a mantener una carta de vinos viva: referencias, formatos, precios, disponibilidad, recomendaciones, stock, rotacion y margen. La integracion no cambia el sistema de cobro ni la operativa de sala."),
    p("Agora sigue siendo el TPV de referencia. Winerim evita que el restaurante tenga que mantener manualmente el mismo vino y sus formatos en dos sistemas."),
    table([
        ["Sistema", "Responsabilidad principal", "No asume"],
        ["Agora", "Comandas, mesas, lineas vendidas, cobros, cierre y documento fiscal.", "Carta especializada, escandallos o contabilidad externa."],
        ["Winerim", "Catalogo de vinos, formatos, PVP, stock de vino, historial y analitica.", "Pagos, cierre de caja, cocina o facturacion."],
        ["tSpoonLab", "Recetas, escandallos, menus, armonias, compras y stock teorico de cocina.", "Cobro o fuente maestra del PVP de vino."],
        ["Holded", "Facturacion, contabilidad y documentos administrativos.", "Operacion de sala o stock operativo de vino."],
    ], [29 * mm, 70 * mm, 59 * mm]),
    p("Principio de arquitectura: cada dato tiene una sola fuente de verdad y cada movimiento conserva un identificador idempotente.", "Callout"),
    p("Valor para las partes", "H2x"),
    table([
        ["Restaurante", "Agora", "Winerim"],
        ["Menos doble trabajo, precios mas consistentes y trazabilidad de botella, copa y magnum.", "Mas valor para clientes con una carta de vino relevante sin desplazar el TPV.", "Ventas reales para mejorar stock, margen, rotacion y decisiones."],
    ], [52.5 * mm, 52.5 * mm, 52.5 * mm]),
    PageBreak(),
])

# Page 3
story.extend([
    section_title("2", "Flujo Winerim + Agora"),
    table([
        ["Flujo", "Datos", "Regla operativa"],
        ["Winerim -> Agora", "Familias/categorias de vino, producto, formato y PVP.", "Solo referencias activas con precio. Ocultacion reversible si dejan de ser vendibles."],
        ["Agora -> Winerim", "Documento, linea, producto, cantidad, importe, IVA y hora real.", "Importacion idempotente. Factura cerrada como reconciliacion definitiva."],
        ["Stock Winerim", "Botella, copa y magnum por stockId independiente.", "Descuenta si stock esta activo; registra venta sin tocar stock si esta desactivado."],
        ["Tickets abiertos", "Ventas del servicio antes del cierre.", "Piloto casi en tiempo real con edad minima y reversion de cancelaciones."],
    ], [35 * mm, 59 * mm, 64 * mm]),
    p("El mismo evento no puede descontar dos veces aunque haya reintentos, el TPV se apague o la factura cerrada llegue despues de un ticket abierto.", "Callout"),
    p("Variantes y catalogo", "H2x"),
    bullet("Botella, copa y magnum son productos/formats vendibles separados y se mapean contra variantes independientes de Winerim."),
    bullet("Un vino inactivo o un formato sin precio deja de estar visible de forma reversible; si vuelve a activarse y recupera precio, se publica de nuevo."),
    bullet("Los productos antiguos nunca se borran como parte del piloto. Se preservan IDs, historico y posibilidad de rollback."),
    p("Disponibilidad y resiliencia", "H2x"),
    bullet("Limite por conexion, reintentos acotados y circuit breaker para no saturar el servidor Agora."),
    bullet("Si el TPV esta apagado, no se pierden ventas cerradas: se recuperan al volver mediante reconciliacion por fecha/documento."),
    bullet("Cada conexion queda aislada por cliente y mantiene credenciales, estado, cola y alertas propios."),
    PageBreak(),
])

# Page 4
story.extend([
    section_title("3", "Menus y armonias con tSpoonLab"),
    p("El caso Saddle introduce una necesidad distinta a una venta directa de vino: una sola tecla de menu o armonia en Agora puede representar varias referencias y cantidades definidas en tSpoonLab."),
    table([
        ["Paso", "Resolucion propuesta"],
        ["1. Venta", "Agora entrega documento, linea, codigo TPV, cantidad, hora y estado."],
        ["2. Composicion", "El middleware resuelve el codigo TPV contra el menu/receta de tSpoonLab."],
        ["3. Instantanea", "Se guarda la composicion/version aplicable a esa venta, no solo la receta actual."],
        ["4. Consumo", "Los componentes de vino mapeados generan consumo en Winerim por formato."],
        ["5. Cancelacion", "Una anulacion genera una reversion idempotente; no se elimina el movimiento original."],
    ], [35 * mm, 123 * mm]),
    p("No recomendamos obligar al camarero a marcar una segunda linea a precio cero si Agora puede exportar el codigo del menu y tSpoonLab aporta su composicion. Esa duplicidad operativa solo seria un fallback.", "Callout"),
    p("Dato que debe confirmar Agora", "H2x"),
    bullet("Identificador estable de documento y linea, codigo del articulo y codigo padre/modificador cuando exista."),
    bullet("Si la exportacion refleja componentes elegidos de menus o solo la tecla padre."),
    bullet("Como se representan anulaciones, devoluciones y cambios de cantidad."),
    bullet("Endpoint recomendado para observacion intradia y endpoint cerrado para reconciliacion."),
    p("Dato que aporta tSpoonLab", "H2x"),
    bullet("Centro de coste, libro de elaboraciones, menus/recetas, componentes, cantidades, unidades y codigo TPV."),
    bullet("La API documenta login, headers de contexto y lectura de menus, recetas, platos y albaranes de venta."),
    PageBreak(),
])

# Page 5
story.extend([
    section_title("4", "Extension contable con Holded"),
    p("Holded se incorpora como destino contable, no como intermediario de la venta ni como fuente de stock de vino. La API v2 utiliza REST/JSON, Bearer auth y paginacion por cursor."),
    table([
        ["Fase", "Accion", "Guardrail"],
        ["Descubrimiento", "Leer productos, contactos, almacenes, impuestos, series y documentos.", "Token v2 con permisos minimos de lectura."],
        ["Dry-run", "Construir factura/albaran previsto sin enviarlo.", "Comparar redondeo, IVA, contacto, moneda y serie."],
        ["Canary", "Crear un unico documento de prueba autorizado.", "Clave idempotente y verificacion posterior."],
        ["Produccion", "Enviar documentos validados y confirmar resultado.", "No marcar tSpoonLab como contabilizado hasta persistir el ID Holded."],
        ["Error/reintento", "Mantener documento pendiente y reintentar de forma controlada.", "Nunca crear una segunda factura por el mismo origen."],
    ], [31 * mm, 63 * mm, 64 * mm]),
    p("La integracion contable no cambia el contrato con Agora. Agora aporta la verdad operativa de la venta; tSpoonLab puede aportar documentos/composiciones; Holded recibe el documento administrativo acordado.", "Callout"),
    p("Decisiones que deben cerrarse con el cliente", "H2x"),
    bullet("Que documentos deben llegar a Holded: facturas, tickets, albaranes, compras o una combinacion."),
    bullet("Que sistema genera la numeracion fiscal y cual solo replica datos."),
    bullet("Que sistema controla compras y costes, y si el stock de vino permanece exclusivamente en Winerim."),
    bullet("Politica de abonos, cancelaciones, descuentos, propinas, redondeos e impuestos."),
    PageBreak(),
])

# Page 6
story.extend([
    section_title("5", "Piloto y validacion partner"),
    table([
        ["Hito", "Validacion", "Resultado"],
        ["1. Aprobacion", "Agora confirma patron API, permisos y cliente autorizado.", "Alcance acordado"],
        ["2. Lectura", "Familias/categorias, productos, ventas y documentos sin escribir.", "Mapa inicial"],
        ["3. Mapping", "Producto y variante; menu/armonia y composicion si aplica.", "Cobertura medible"],
        ["4. Catalogo", "Familias/productos Winerim en entorno controlado y reversible.", "Validacion visual"],
        ["5. Venta", "Botella, copa y menu/armonia; historial y stock segun configuracion.", "Dato fiable"],
        ["6. Cancelacion", "Reversion de una linea/ticket sin duplicar movimientos.", "Idempotencia"],
        ["7. Cierre", "Factura cerrada reconcilia el servicio y corrige diferencias.", "Piloto cerrado"],
    ], [28 * mm, 96 * mm, 34 * mm]),
    p("Criterio de exito", "H2x"),
    p("Una venta realizada en Agora aparece una sola vez en Winerim con su hora real y variante correcta; afecta al stock solo cuando corresponde; una cancelacion se revierte una sola vez; y la factura cerrada reconcilia sin duplicar."),
    p("Confirmaciones solicitadas a Agora", "H2x"),
    bullet("Endpoints y permisos oficiales para exportacion de ventas e importacion/actualizacion de productos."),
    bullet("Campos estables por documento, linea, producto, variante/modificador y cancelacion."),
    bullet("Comportamiento de familias frente a categorias y recomendacion actual para nuevas integraciones."),
    bullet("Limites de frecuencia, tamanos de payload, autenticacion, caducidad y soporte."),
    bullet("Sandbox, certificacion partner o instalacion de prueba, si existe."),
    bullet("Contacto tecnico para resolver menus, armonias y casos borde durante el piloto."),
    p("Siguiente paso propuesto: reunion tecnico-comercial de 30 minutos para confirmar estos puntos y seleccionar un cliente piloto autorizado.", "Callout"),
    PageBreak(),
])

# Page 7
story.extend([
    section_title("6", "Seguridad, trazabilidad y fuentes"),
    p("Garantias operativas", "H2x"),
    bullet("Credenciales por conexion, almacenadas en backend y nunca incluidas en logs o respuestas."),
    bullet("Acceso de minimo privilegio y HTTPS obligatorio para tSpoonLab y Holded."),
    bullet("Rate limit, timeout, reintentos y circuit breaker por conexion."),
    bullet("Colas idempotentes, historico de errores, recuperacion y rollback reversible."),
    bullet("Escrituras desactivadas hasta completar lectura, matching, dry-run y canary."),
    p("Fuentes tecnicas oficiales revisadas", "H2x"),
    p("tSpoonLab REST API Developers<br/>https://documents.tspoonlab.com/es/collections/1621268-rest-api-developers", "Smallx"),
    p("tSpoonLab - integracion de ventas TPV y sistemas de facturacion<br/>https://documents.tspoonlab.com/es/articles/4197483-integracion-de-ventas-a-traves-de-tpv-s<br/>https://documents.tspoonlab.com/es/articles/2760420-rest-api-integracion-con-sistemas-de-facturacion-recuperar-datos-de-tspoonlab", "Smallx"),
    p("Holded Developers y generacion de API Token<br/>https://www.holded.com/developers<br/>https://help.holded.com/es/articles/6896051-como-generar-y-usar-la-api-de-holded", "Smallx"),
    Spacer(1, 10 * mm),
    HRFlowable(width="100%", thickness=1, color=LINE, spaceAfter=10),
    p("Contacto Winerim", "H2x"),
    p("Goiko - CTO / Integraciones<br/>goiko@winerim.com<br/>+34 685 739 010"),
    p("Winerim mantiene Agora como TPV de referencia y conecta el vino con ventas, stock, margen y decisiones sin romper la operativa del restaurante.", "Callout"),
])


def main():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    doc = PartnerBriefDoc(str(OUTPUT))
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    main()
